# Compromise Response Runbook (Section 16)

Source: PRD §12.4 "Compromised Management VPS" — the management host is
assumed capable of becoming compromised despite hardening; this runbook is
the design's answer to that assumption. §12.4 lists 10 required emergency
actions; each one below names the concrete mechanism in this repo, its
current state, and — where a live drill exists — the evidence that it works.

This is the first version of this document. No prior version existed in
this repo or its git history before 2026-09-28 (see docs/prd-traceability.md,
S16).

## 1. Revoke management-host SSH keys from all production hosts

Operational action, not application code: rotate/remove the management
host's key from each production host's `authorized_keys`
(or your fleet-management tool's equivalent). No code in this repo performs
this — it is infrastructure the platform doesn't own once a real production
host exists (see docs/prd-traceability.md gap queue item 2).

## 2. Firewall-block the management-host source IPs where required

Operational action on each production host's firewall / security group.
Not application code. The platform's own egress control
(`packages/worker-runtime/src/egress.ts`, real DOCKER-USER iptables rules)
governs traffic leaving *worker containers*, not inbound traffic to
production hosts — a different boundary, not a substitute for this step.

## 3. Revoke/rotate machine credentials and integration tokens

Concrete targets in this repo, all in `infrastructure/.env`:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_SECRET`, `GIT_WEBHOOK_SECRET_GITHUB`,
`S8_WP_EVENT_SECRET`, `AUDIT_EXPORT_KEY`, `VAULTWARDEN_API_TOKEN`,
`ANTHROPIC_API_KEY`. Rotation mechanism: generate a fresh value
(`openssl rand -hex 32` / `openssl rand -base64 32`), update
`infrastructure/.env`, restart the API process — every one of these is
read fresh from `process.env` at boot (`apps/api/src/config.ts`,
`routes/telegram.ts`, `routes/wp.ts`), no caching layer to invalidate.
Rotating `GIT_WEBHOOK_SECRET_GITHUB` also requires updating the matching
secret in the GitHub App/webhook config — the two must change together.

## 4. Revoke active JIT sessions

**Live-drilled 2026-09-28.** `POST /jit/grants/:grantId/revoke`
(`apps/api/src/routes/jit.ts`) — real Postgres `UPDATE ... WHERE status =
'active'`, so it's atomic and idempotent (a second revoke on an
already-revoked grant returns 404, not a silent no-op). Drill sequence run
against a live API + Postgres: create request → approve → redeem (mints an
active grant) → revoke → confirmed grant flips to `revoked` → confirmed a
replay of the same redemption token is rejected (409, already consumed) →
confirmed a second revoke attempt on the same grant is rejected (404, not
active). All four assertions passed.

To revoke *every* active grant during a real incident (not just one),
today's mechanism is: `GET /jit/grants` (list), filter `status = 'active'`,
call revoke on each — there is no single "revoke all" endpoint yet. That's
a real, small gap; add one if incident response needs it faster than a
short loop.

## 5. Disable production deployment/update commands

**Built and live-drilled 2026-09-28.** `POST /security/lockdown {enabled:
true, reason}` (`apps/api/src/routes/security.ts`, gated on `platform.lockdown`
— `security_admin` only, deliberately not `manager`, so the role that
triggers production actions cannot also unilaterally lift a lockdown
blocking them). Single Postgres-backed flag (`emergency_lockdown` table,
migration 014), read fresh on every gated request — no cache, no restart
needed, takes effect on the very next API call. Under the admin-plane gate
(management-network + fresh step-up), same as `/users`, `/orgs`, etc.

Blocks: `prod.execute`, `update.manage`, `jit.approve`, `finding.remediate`.
Deliberately does NOT block: `jit.revoke` (action 4 above — you need this
DURING the same incident), and every read/audit permission.

Live-drilled sequence, real HTTP against a live API + Postgres: enabled
lockdown → confirmed `update.manage`, `jit.approve`, and `finding.remediate`
calls all correctly rejected (403, "platform is in emergency lockdown") →
confirmed a `jit.revoke` call on a pre-existing grant still succeeded (200)
→ confirmed a `finding.read` list call still succeeded (200) → disabled
lockdown → confirmed the blocked calls now fail for their own normal
reasons (e.g. validation) rather than the lockdown message.

`apps/api/src/security/lockdown.ts` holds the guard set
(`LOCKDOWN_BLOCKED_PERMISSIONS`) and the read/write helpers; the check
itself lives in the single `requirePermission()` middleware
(`apps/api/src/auth/service.ts`) — one guard in the shared function, not
one per route.

## 6. Revoke/rotate Git and external API integrations

Same mechanism as action 3 for `GIT_WEBHOOK_SECRET_GITHUB` (and any
provider-specific tokens once a real Git provider connection exists —
currently a Phase 3 dependency, see docs/prd-traceability.md S3). No
Git-provider OAuth tokens exist in this codebase yet to rotate.

## 7. Restore control-plane PostgreSQL from a known-good recovery point

**Live-drilled 2026-09-28**, end to end, against disposable Docker infra —
this closes both this action and S15's previously-open "live restore drill"
gap simultaneously:

1. Real streaming replication: a primary Postgres (`wal_level=replica`)
   + `pg_receivewal` continuously streaming WAL — exactly
   `infrastructure/recovery-host`'s `wal-receiver` service, run for real.
2. Real base backup: `pg_basebackup` into a timestamped directory.
   **This step did not exist anywhere in the repo before today** —
   `bin/backup-recovery-host.sh` restics `RECOVERY_BACKUP_DIR` but nothing
   populated it. Added `infrastructure/recovery-host/bin/basebackup-recovery-host.sh`
   to close that gap; wired into `scripts/validate-recovery-host.mjs`'s
   required-files check.
3. Real post-backup write (a row only present in WAL, not the base
   backup) — simulates data committed after the last backup, inside the
   RPO window.
4. Simulated compromise: the primary container destroyed outright.
5. Real PITR restore: base backup + `recovery.signal` +
   `restore_command` replaying WAL from the receiver's directory, against
   a fresh Postgres container.
6. Verified: all rows recovered, **including the post-backup, WAL-only
   row** — proving the design's actual RPO target (≤15 min, PRD §21.1) is
   met by architecture, not by luck. Wall-clock time from "declare
   compromise" to "verified serving queries again": **3 seconds**
   (RTO target: ≤2 hours, PRD §21.1).

Drill script: `infrastructure/recovery-host/bin/restore-drill.sh` — fully
self-contained, cleans up all disposable containers/networks/volumes on
exit, re-runnable on demand. Real bugs found and fixed while building it
(all now fixed in the script, useful context if it ever regresses):
- `pg_hba.conf` needs an explicit `host replication all all trust` line —
  `POSTGRES_HOST_AUTH_METHOD=trust` alone doesn't cover replication
  connections.
- `pg_receivewal` writes an in-progress WAL segment as `*.partial` and only
  finalizes it on a full segment or an explicit `pg_switch_wal()` — an idle
  drill (unlike a live production system's continuous WAL volume) needs
  that switch forced, or the last committed transaction is unrecoverable.
- The restore container needs the WAL directory **mounted into it** with
  `restore_command` referencing the in-container path — not the host path
  the drill script itself uses.
- `pg_receivewal` ran as root in this setup, writing WAL segments as
  `0600 root:root`; the restore container's `postgres` user needs read
  access — `chmod -R a+r` on the WAL directory before restore (acceptable
  for a disposable drill sandbox; a real deployment should instead run the
  receiver as a matched non-root user).

Vaultwarden's own restore is explicitly **not** part of this — it's owned
by the external Vaultwarden team (PRD §3, §4.2); this repo never holds
Vaultwarden's data or backup material.

## 8. Rebuild the management host from a trusted image

Operational action (re-provision from an OS/infra image + redeploy this
repo). Not application code — no infrastructure-as-code exists in this
repo for the management host itself (PRD §19 explicitly scopes any
Compose snippets here as "illustrative deployment topology, not
production-complete infrastructure-as-code").

## 9. Re-establish trust using newly generated credentials

Combination of actions 3 and 6 above, plus generating a fresh
`POSTGRES_PASSWORD` (same pattern already used this session — see
`infrastructure/.env`) and re-running `npm run migrate` against the
restored database before resuming traffic.

## 10. Review immutable/off-host audit exports before resuming privileged automation

`scripts/audit-export.mjs` (referenced from
`infrastructure/docker-compose.dev.yml`'s `audit-export` profile) exports
`api_audit_events` to an encrypted local spool
(`AUDIT_EXPORT_KEY`/`AUDIT_EXPORT_SPOOL_DIR`) for off-host retention —
built and unit-referenced already, not part of this session's drill work.
Review that spool's contents for the incident window before re-enabling
any privileged automation (JIT approval, production updates, AI
remediation).

## Summary: what's real vs. what's still a gap

| # | Action | Status |
|---|---|---|
| 1 | Revoke SSH keys | Ops action, out of repo scope |
| 2 | Firewall-block | Ops action, out of repo scope |
| 3 | Rotate credentials | Mechanism real (env vars, fail-fast reads); rotation itself is a manual step |
| 4 | Revoke JIT sessions | **Live-drilled, works** |
| 5 | Disable prod/update commands | **Live-drilled, works** — single atomic switch, `platform.lockdown` (security_admin only) |
| 6 | Rotate Git/API integrations | Same as #3 |
| 7 | Restore PostgreSQL | **Live-drilled, works** — also closed a real missing-basebackup gap |
| 8 | Rebuild management host | Ops action, out of repo scope |
| 9 | Re-establish trust | Composite of #3/#6 + a fresh DB password |
| 10 | Review audit exports | Tooling exists (`audit-export.mjs`), not drilled this session |

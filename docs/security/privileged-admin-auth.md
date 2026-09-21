# Privileged admin authentication, management-host restriction, off-host audit export

**Status:** IMPLEMENTED (S2-D2, 2026-08-24). Owner: pam-mt3xnzu6 (D2 Platform).
**Builds on:** S2-D1 primitives (jim, feature/s2-auth): scrypt passwords, opaque bearer sessions (`api_sessions`), default-deny RBAC resolver + `requirePermission`, centralized audit service (`recordAudit`, `api_audit_events`).
**Build plan ref:** Section 2 → Developer 2.

## Scope

App-level privileged administration: who counts as a privileged admin, how they authenticate beyond an ordinary session, where administration may be performed from, and how the audit trail leaves the host append-only.

Non-goals (owned elsewhere): host SSH/JIT (`ops/networking-ssh.md`), edge TLS/admin-off (`ops/caddy-secrets.md`), WP-side JIT redemption, auth core/RBAC/audit service internals (S2-D1), UI surfaces (S2-D5), authz matrix tests (S2-D6).

## 1. Privileged admin authentication — DONE

- **Privileged permission set** — the admin plane is every permission except tenant-facing ones: `org.manage`, `project.manage`, `user.manage`, `role.assign`, `audit.read`. Single source of truth: `PRIVILEGED_PERMISSIONS` in `apps/api/src/auth/privileged.ts`.
- **Step-up authentication** — privileged routes require a fresh password re-proof on top of a valid session. `POST /api/v1/auth/step-up {password}` re-verifies via scrypt and stamps `api_sessions.step_up_at = now()`.
  - Proof max age: `ADMIN_STEPUP_TTL_MIN` (default 15 min). Per-session scope: one step-up covers all privileged routes for the window.
  - Stale/missing proof → `403 FORBIDDEN` with `details.stepUpRequired = true` (audited `authz.deny.stepup.stale`) so UIs can trigger re-auth.
- **Session classes** — ordinary session: TTL `AUTH_SESSION_TTL_HOURS` (24h default). Privileged capability is never persistent: it lives only in the bounded step-up window and dies with the session (revocation/deactivation kills both immediately, unchanged from S2-D1 behavior).
- **Break-glass** — human-approved only; Telegram NEVER authorizes production break-glass (PRD hard rule). Procedure: request → human approver grants time-boxed role binding via normal `POST /role-bindings` (audited) → mandatory post-use review revokes it. No separate break-glass credential exists.
- **No shared/permanent credentials** — named accounts only; aligns with host-level JIT.
- **Brute-force resistance** — `/auth/step-up`: per-user sliding-window limit `ADMIN_STEPUP_MAX_ATTEMPTS` in `ADMIN_STEPUP_WINDOW_MIN` (5 / 15 min default) → `429 RATE_LIMITED`; wrong password audited (`auth.stepup` deny) and returns generic `UNAUTHORIZED`.
- **Secrets handling** — export key etc. via runtime injection only; nothing secret in repo.

## 2. Management-host administration restriction — DONE

- **Management plane** = all admin routes (`/users`, `/role-bindings`, `/orgs`, `/projects`, `/environments`, `/audit-events`) + PG direct port (:5433-class) + container/host tooling. Tenant traffic never overlaps these prefixes.
- **Network restriction first** — public edge never proxies admin routes (Caddy `admin off` precedent). On servers, `ADMIN_NETS` lists allowed CIDRs (loopback + WireGuard mgmt net `10.10.0.0/24`); PG :5433 binds stay loopback/private per compose.
- **App-layer deny-by-default** — `onRequest` hook in `apps/api/src/routes/security.ts` guards every admin URL: network origin check (`assertManagementNetwork`, unparseable IP matches nothing → audited `admin.network.deny`, `403`) → actor resolution → fresh-step-up check. Dev compose parity: default `ADMIN_NETS` is loopback-only, matching localhost-only port binds.
- **Audit feed is privileged too** — `GET /audit-events` sits behind the same network + fresh-step-up chain (`audit.read`): a session without a fresh proof gets `403 details.stepUpRequired` even when its purpose is debugging those very denials. Re-step-up first; expect the step-up itself to appear in the feed.
- **Separation of duties** — self-targeting user/role writes rejected by S2-D1's `assertNotSelf`; every denial still emits an audit event.
- Enforcement lives in ONE file (`security.ts`) so no existing route files changed; registration in `server.ts` is additive (2 lines).

## 3. Append-only / off-host audit export — DONE

- **Event schema** — verbatim reuse of jim's `api_audit_events` rows (actor, action, result, scope triple, resource, requestId, details, created_at); correlation keys match `ops/logging.md`.
- **Append-only guarantee** — application DB role gets INSERT/SELECT only on `api_audit_events`: grant template at `infrastructure/db/audit-append-only.sql` (REVOKE UPDATE/DELETE/TRUNCATE at GRANT level, applied on servers with the dedicated runtime role; dev runs as owner and skips it).
- **Off-host shipper** — `apps/api/tools/audit-export.mjs` (zero new deps; uses existing `pg`). Cron-friendly one-shot: reads events after the watermark, writes ONE AES-256-GCM encrypted NDJSON batch per run into the local spool, appends to `manifest.jsonl`, then advances `state.json`. Compose wrapper: `docker compose --profile audit-export run --rm audit-export`; prod scheduling = host timer.
  - **Transport swap point:** the spool is deliberately transport-agnostic — files are opaque blobs named `<seq>-<ts>.ndjson.enc` plus `manifest.jsonl`. Any rsync/scp/rclone pickup works today; when the human picks a real off-host destination, replace ONLY the pickup step (cron job or add a shipper sidecar); the script and layout do not change.
- **Integrity** — sha256 hash chain: each manifest entry records `prevHash` → `hash = sha256(prevHash || canonical(events))`. `node tools/audit-export.mjs --verify` walks the whole chain (decrypt + recompute); truncation/tampering breaks verification on import.
- **Failure policy** — any error exits non-zero BEFORE the watermark moves (crash = same rows re-export next run, zero loss). Retry/backoff belongs to the scheduler.
- **Spool-full policy (DECIDED, god 2026-08-24):** cap `AUDIT_EXPORT_MAX_MB` (100 MB default); when full the exporter drops `.SPOOL_FULL` and exits 2. The API checks that sentinel before issuing step-ups (`AUDIT_SPOOL_DIR`) — NEW PRIVILEGED operations are blocked (`503 UNAVAILABLE`, audited `authz.deny.spool_full`) while normal traffic keeps running. Drain off-host, delete sentinel, resume.
- **Retention/access** — key via secret injection (`AUDIT_EXPORT_KEY`, 32-byte base64); readership limited to audit-viewer class.

## Verification hooks (feed Oscar / S2-D6)

| Test | Expectation |
|---|---|
| Privileged call without fresh step-up | `403` + `details.stepUpRequired=true` + audited deny |
| Step-up with wrong password ×6 | 5×`401`, 6th `429`, all audited |
| Admin route from non-mgmt IP | `403` + audited `admin.network.deny` |
| Self-approval attempt | rejected (`assertNotSelf`), audited |
| `UPDATE`/`DELETE` on api_audit_events as app role | fails at DB grant level |
| Export outage until cap | `.SPOOL_FULL` appears, step-ups blocked w/ `503`, zero event loss |
| Tamper/truncate a spool batch | `--verify` reports chain-break/tamper |

## Resolved decisions

1. ~~Session/token storage~~ — landed in S2-D1.
2. ~~Audit-event write API~~ — landed in S2-D1.
3. Off-host destination — NOT chosen by human yet; local encrypted spool ships now, swap point documented above. Revisit when decided.
4. Spool-full mode — BLOCK new privileged-only ops (ratified default).

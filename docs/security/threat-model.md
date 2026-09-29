# Threat Model (Section 17)

Source: PRD §12 "Threat Model" (7 attacker scenarios, §12.1-§12.7) and §13
(RBAC hierarchy). This document organizes what PRD §12 already specifies
into a per-scenario control-mapping — file:line evidence for what's
actually built, and an honest residual-risk/gap call for what isn't.

No prior version of this document existed in this repo or its git history
before 2026-09-28 (see docs/prd-traceability.md, S17).

**Live adversarial drills** (actually attacking a running instance to prove
these controls hold under pressure, not just reading the code) are **not**
included here — they need a target environment this session doesn't have
(see docs/prd-traceability.md gap queue). What follows is the design-level
mapping plus whatever functional drills already exist from other sessions'
work (S16, mostly).

---

## 12.1 Compromised Developer Workstation

**Assumed attacker capability:** browser/session state, Git credentials,
local repo access, Telegram account/session, project knowledge.

| Required control | Implementation | Status |
|---|---|---|
| Project-scoped RBAC | `packages/shared/src/rbac.ts` — `permissionsFor()` is default-deny, scoped by org/project/environment | Implemented |
| Fresh authorization for privileged actions | `assertScope()` re-checks exact scope per-request (`apps/api/src/auth/service.ts`); admin plane requires fresh step-up (`auth/privileged.ts`, `assertFreshStepUp`) | Implemented |
| JIT expiry/revocation | `routes/jit.ts` — token-hashed, TTL-bound, atomic redeem (`FOR UPDATE`); revoke live-drilled 2026-09-28 (see S16) | Implemented, drilled |
| No reusable production passwords | JIT model issues one-time tokens per request, never a shared/static credential | Implemented |
| MFA for privileged approvals | **Gap**: `POST /auth/step-up` re-verifies the account password, which is single-factor — a stolen session token *and* stolen password (both plausible on a compromised workstation) defeats it. No TOTP/WebAuthn second factor exists. | **Not implemented** — real gap |
| Anomaly/audit visibility | `recordAudit()` on every privileged action + deny (`auth/audit.ts`) | Implemented |
| Repo access alone ≠ production admin | `git.read`/`git.manage` and `jit.request`/`prod.execute`/`update.manage` are distinct permissions; no role grants git access without also needing a separate privileged grant for production reach | Implemented |

**Residual risk:** a workstation compromise that captures both an active
session token and the account password (e.g. a keylogger, not just cookie
theft) still passes step-up. Closing this needs real MFA — out of scope
for this pass, flagged for a future PRD-approved change.

## 12.2 Compromised Git Provider Account

| Required control | Implementation | Status |
|---|---|---|
| Branch protection / required reviews | Owned by the Git provider (GitHub/GitLab) itself, not this repo's code | Ops/external |
| CI security gates | S5/S14 scanning pipeline (real, live-verified this session) | Implemented |
| Deployment authorization independent of Git push | `update.manage` (S13 state machine) is a separate permission from any Git-side role; promoting requires an explicit `update.promote` action through this platform, not a Git merge | Implemented |
| Environment-scoped permissions | `RoleBindingView` scope model (org/project/environment) | Implemented |
| Signed/verified webhook handling | `docs/security/webhook-ingress-replay.md` — real HMAC + replay protection (`routes/webhooks.ts`) | Implemented |
| No secret material in repo config | All secrets are env vars (`infrastructure/.env`), never committed | Implemented |
| Audit correlation between Git event and production action | `recordAudit` ties `webhook.received` and downstream `update.*`/`prod.*` actions via `requestId` | Implemented |

**Residual risk:** none identified beyond the Phase 3 dependency (a real
Git provider connection doesn't exist yet — see docs/prd-traceability.md
S3 remaining work).

## 12.3 Compromised Production WordPress/CMS

| Required control | Implementation | Status |
|---|---|---|
| Authenticated/signed inbound events | `routes/wp.ts` — HMAC over raw body, per-site key or global fallback (`S8_WP_EVENT_SECRET`) | Implemented |
| Replay protection | `wp_events` unique constraints + freshness window | Implemented |
| Strict schema validation | zod schemas on every inbound payload | Implemented |
| Bounded payload sizes | `WEBHOOK_BODY_LIMIT_BYTES` | Implemented |
| No command execution from webhook contents | `wp.ts` only records events into Postgres; nothing in that path shells out or interprets payload contents as commands | Implemented |
| Project/site identity verification | `X-WP-Site` header + `wp_event_signing_keys` (migration 007) per-site rows | Implemented |
| Rate limiting | `WEBHOOK_RATE_MAX`/`WEBHOOK_RATE_WINDOW_MIN` | Implemented |
| Asynchronous processing | pg-boss job dispatch, not inline synchronous handling of untrusted input | Implemented |
| No direct central-worker RCE from production | Worker isolation boundary (§12.6/Section 6) is the actual enforcement point; the WP ingest path itself has no execution surface | Implemented |

**Residual risk:** none identified; this scenario's controls are all real
and match the PRD closely.

## 12.4 Compromised Management VPS

See `docs/security/compromise-response-runbook.md` — the full 10-action
runbook, with 2 actions (PostgreSQL restore, JIT revocation) and the
emergency-lockdown switch (action 5) all live-drilled this session (S16).
Not repeated here to avoid the two documents drifting out of sync.

## 12.5 Malicious or Abusive Authorized User

| Required control | Implementation | Status |
|---|---|---|
| Least privilege | Role/permission matrix (`rbac.ts`) | Implemented |
| Project/environment scope | Same scope model as 12.1 | Implemented |
| Default-deny RBAC | `permissionsFor()` returns only explicitly granted permissions | Implemented |
| Separation of duties | `security_admin` holds no general business permissions (rbac.ts comment, line 85-87); `platform.lockdown` deliberately excluded from `manager` so the role that triggers prod actions can't unilaterally lift a lockdown blocking them (S16, 2026-09-28) | Implemented |
| No self-approval for critical actions | `assertNotSelf()` (`auth/service.ts`) | Implemented |
| Short-lived privileged grants | JIT `duration_minutes`, step-up `ADMIN_STEPUP_TTL_MIN` | Implemented |
| Immutable audit export | `scripts/audit-export.mjs` → encrypted local spool | Implemented, not live-drilled this session |
| Manager/security-admin review paths | JIT approve, update-unit approve/promote, remediation review-before-use | Implemented |

**Residual risk:** none identified in design; audit-export review itself
(reading the spool during a real incident) hasn't been exercised live.

## 12.6 Compromised Scanner / Malicious Repository

Controls are defined by the scanner-worker isolation boundary
(`docs/security/worker-runtime-isolation.md`). Directly relevant to this
session's own work: the egress-allowlist mechanism
(`packages/worker-runtime/src/egress.ts`) was verified live on a real
Linux host with real iptables — a non-allowlisted destination was blocked,
an allowlisted one passed, confirmed via real curl containers (see
docs/prd-traceability.md S4). Resource limits come from
`scanner/profiles.json` ceilings (`profileForTool`), never inline numbers,
so a malicious repository can't negotiate its own limits.

**Residual risk:** `spec.egress.allowlist` is opt-in — no caller populates
a real allowlist yet, so default bridge egress is unrestricted until a
caller opts in (documented gap, S4).

## 12.7 Compromised AI Provider or Prompt Context Leakage

| Required control | Implementation | Status |
|---|---|---|
| Explicit user-trigger only | `POST /findings/:id/remediate` is human-initiated; nothing in the scheduler auto-enqueues `ai_remediation` jobs | Implemented |
| Secret redaction before submission | `redactForProvider()` (`packages/shared/src/ai-provider.ts`) — regex-based, applied to every field sent to the provider | Implemented |
| Scoped code context | `codeContext` capped at 20,000 chars (zod schema, `classes.ts`) | Implemented |
| No production credentials in prompts | Nothing in the remediation request path fetches or forwards credentials | Implemented |
| Provider/model audit log | `api_ai_remediation_requests` stores `provider`/`model` per request; `recordAudit` on the triggering action | Implemented |
| Enterprise/no-retention configuration | **Gap/N/A**: this is an Anthropic-account-level setting, not something this repo's code can enforce or verify — document as an operational requirement on whoever configures the API key, not a code control | Ops, not code |
| Configurable provider allow-list | `AI_REMEDIATION_ALLOWED_MODELS` env var, checked against `config.model` before every call (`ai-provider.ts` line 67) | Implemented |
| Cost/token limits | `maxTokens` (default 4096) + `timeoutMs` (default 60s) per call | Implemented |
| No automatic production deployment | PRD §8.4 steps 5-8 (branch write, CI checks, human review, PR creation) are explicitly out of scope for this code path — it stops at a stored proposal for human review (docs/prd-traceability.md S20) | Implemented |

**Residual risk:** none identified beyond the account-level retention
setting, which is inherently outside this codebase's control.

---

## Summary

| Scenario | Real gaps found |
|---|---|
| 12.1 Workstation | No true MFA on step-up (password-only second factor) |
| 12.2 Git provider | None (Phase 3 dependency only) |
| 12.3 Production CMS | None |
| 12.4 Management VPS | See compromise-response-runbook.md (only ops-only actions + one un-drilled audit-review step remain) |
| 12.5 Abusive authorized user | None |
| 12.6 Scanner/repo | Egress allowlist opt-in, not yet populated by any caller (pre-existing, documented) |
| 12.7 AI provider | None (retention setting is account-level, not code) |

**Not done in this pass, and needs a real target environment:** live
adversarial drills — actually attempting each of these attacks against a
running instance, rather than confirming the design and code exist. That's
explicitly out of reach on this machine (no real production host, no real
external accounts to attack safely) and should be scoped as its own task
once Phase 3 infrastructure exists.

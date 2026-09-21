# Secure Git Webhook Ingress + Replay Protection (S3-D2 design)

Status: **IMPLEMENTED** (S3-D2, branch fix/s3-webhook-ingress off main b27f51e).
Contracts resolved from packages/shared/src/git.ts (S3-D1). Test hooks map to
oscar's S3-D6 abuse battery. Owner: pam (D2).

## Threat model (PRD §12.3 hard rules)
- Forged webhooks (no / bad signature) must never reach app logic as trusted input.
- Replayed deliveries must not double-trigger pipeline side effects.
- Payload contents must NEVER drive command execution (PRD line 1000/1635) —
  ingress persists an envelope and enqueues a job; workers re-derive state server-side.

## Ingress topology
GitHub/GitLab → Caddy (:443) → API `POST /webhooks/git/:provider`
- Caddy: TLS termination + reverse proxy only (no body buffering changes); optional
  connection-level rate limit later — not required for DoD.
  RULING (god): public ingress path, signature-gated — no ACL work in DoD.
- Route lives OUTSIDE `/api/v1` auth plane: no session token; signature IS the credential.
- Provider slug allow-listed against `GIT_PROVIDERS` env (day-one ruling: `github` only);
  unknown provider → 404 NOT_FOUND identical to the root not-found handler
  (do not confirm the endpoint exists to probes). Add nothing GitLab-shaped.

## Layer 1 — Signature authentication (`apps/api/src/routes/webhooks.ts`)
1. RAW request body captured before JSON parse by a plugin-scoped content-type
   parser (`rawBody` buffer) — signatures are computed over original bytes;
   /api/v1 parsing is untouched (encapsulation scope).
2. HMAC-SHA256(rawBody, secret) vs `WEBHOOK_SIGNATURE_HEADERS[provider]`
   (github: `x-hub-signature-256`, format `sha256=<hex>`).
   - `crypto.timingSafeEqual` ONLY, after length check (never leak length mismatch info).
   - Malformed/absent header and wrong MAC both → generic 401 UNAUTHORIZED.
3. Secret source: `GIT_WEBHOOK_SECRET_<PROVIDER>` env from /etc/platform/api.env,
   injected per secret-management convention; NEVER in repo or compose file.
4. Failure: audited via recordAudit (`webhook.sig.deny`, actorId null = system),
   requestId, provider, ip.

## Layer 2 — Replay / duplicate protection (the infrastructure-boundary part)
Mechanism lives on jim's S3-D1 table — NO separate deliveries table:
`api_webhook_events UNIQUE(connection_id, delivery_id)` (004_git_integration.sql).
Handler: INSERT ... ON CONFLICT DO NOTHING → no row inserted ⇒ duplicate ⇒
**200 ok({duplicate:true})** (providers stop retrying, nothing re-enqueues).
Migration 005 adds only `idx_webhook_events_received_at` for retention pruning.

Staleness window: HTTP `Date` header older than WEBHOOK_MAX_AGE_MIN (default 10)
→ 400 VALIDATION_ERROR `stale-delivery`, audited (`webhook.stale.deny`).
- ponytail ceiling (honest limits): Date header is NOT HMAC-covered and GitHub
  sends no signed timestamp, so staleness is ADVISORY hardening against
  intercept-and-replay-later; the PK dedupe is the authoritative guarantee.
- ponytail ceiling: single-writer PG unique index stays correct at any scale-out
  (DB constraint, not memory); partition only if volume demands.
Delivery log doubles as ops evidence + oscar's test oracle.

## Layer 3 — No-execution boundary
- Ingress persists the verified envelope (connection_id, delivery_id, event_type,
  payload JSONB) in one withTx, then enqueues `JOB.webhookReceived {eventId}`
  AFTER commit (pg-boss queue created at plugin boot — v12 declarative queues).
- Workers MUST re-fetch authoritative repo state via provider API using stored
  credentials; payload fields are data, never shell/CLI interpolation.
- JIM TIER-0 REVIEW NOTES:
  a) Enqueue-failure compensation: if boss.send() throws post-commit, the just-
     inserted row is DELETEd (processed_at IS NULL) so the provider retry
     re-accepts instead of hitting duplicate:true and silently dropping the job.
     Residual gap: crash between COMMIT and send loses the delivery until the
     provider retries (at-least-once relies on provider retry behavior).
  b) Duplicate path never enqueues — correct only because send succeeded before
     the first 200 was returned. Worker-side idempotency still required.
  c) Unbound repositories (no active api_repo_links match on external_repo_id OR
     full_name) respond 200 ignored:true WITHOUT audit row: org-level hooks
     deliver every repo, and sustained 4xx would let GitHub disable the hook
     fleet-wide. Misrouting surfaces via req.log.warn instead. Flag if you want
     this audited despite volume risk.

## Abuse limits (route-scoped)
Per-IP+provider sliding window, same in-memory pattern as step-up
(ponytail: per-process, move to shared store if API scales out). Counted BEFORE
HMAC verification (brute-force CPU protection). 429 RATE_LIMITED, audited.

## Response matrix (= oscar's battery fixture map, verbatim + addendum)
| Case | Status | Envelope |
|---|---|---|
| valid first delivery | 200 | ok({deliveryId, accepted:true}) |
| replayed delivery | 200 | ok({duplicate:true}) |
| stale (>max age, Date header) | 422 | VALIDATION_ERROR stale-delivery |
| bad/missing signature | 401 | UNAUTHORIZED (generic) |
| malformed JSON body | 422 | VALIDATION_ERROR |
| unknown event type | 200 | ok({ignored:true}) — do NOT 4xx provider retries for events we ignore |
| unknown provider | 404 | NOT_FOUND |
Addendum rows implemented beyond god's verbatim 7 (documented so the battery can adopt):
| missing delivery-id header | 422 | VALIDATION_ERROR missing-delivery-id |
| signed but repo unbound to any active connection | 200 | ok({deliveryId, accepted:false, ignored:true}) |

NOTE: VALIDATION_ERROR is canonically HTTP 422 per packages/shared/src/errors.ts
(prep doc guessed 400; codebase convention wins). Consumers key on error.code.

## Retention (ruling c)
Raw JSONB kept, pruned at WEBHOOK_RETENTION_DAYS (default 30) by one daily
pg-boss job (`ops.webhook.retention`, cron default `0 3 * * *`,
WEBHOOK_RETENTION_CRON overridable) registered from apps/api/src/jobs/retention.ts
inside the API process until a dedicated worker service exists.

## Env knobs (infrastructure/.env.example)
GIT_PROVIDERS=github | GIT_WEBHOOK_SECRET_GITHUB=<hex> | WEBHOOK_MAX_AGE_MIN=10 |
WEBHOOK_RATE_MAX=30 | WEBHOOK_RATE_WINDOW_MIN=1 | WEBHOOK_BODY_LIMIT_BYTES=10485760 |
WEBHOOK_RETENTION_DAYS=30

## Verification (executed, see S3-D2 done-report)
Throwaway pg + built API (worktree pattern from S2-D2): real HMAC-signed fixtures →
accept (+ pgboss.job row); byte-identical resend → duplicate; tampered body → 401;
stripped signature → 401; clock-shifted → stale 400; malformed bytes → 400; ping
event → ignored 200; gitlab probe → 404; hammer past RATE_MAX → 429; DB row count ==
accepted count throughout; denials present in api_audit_events.

# Structured logging convention (S1-D2-MONITOR)

Scope: API + workers. JSON lines on stdout/stderr only — containers capture them;
no log files inside containers, no new infra services this section.

## Line schema (one JSON object per line)
```jsonc
{ "ts": "2026-08-22T06:56:21.509Z", "level": "info", "svc": "api",
  "msg": "request completed", "requestId": "req-123",
  // optional, context-dependent:
  "route": "POST /api/v1/examples", "status": 200, "durationMs": 12,
  "err": { "code": "VALIDATION_ERROR" } }
```
- `ts` ISO-8601 UTC; `level` one of `fatal|error|warn|info|debug`; `svc` = emitting service (`api`, `<worker-name>`); `msg` short human phrase.
- **Correlation**: every line carries `requestId` matching the inbound `x-request-id` header (API echoes it per api-conventions.md §Tracing). Workers without HTTP context use `jobId` + `queue` instead of `requestId`.
- Extra fields allowed; never nest secrets, tokens, passwords, full SQL, or PII in any field (error-conventions.md §3 rules apply to logs too).

## Severity levels ↔ Dwight's incident scale
| log level | use for | maps to incident |
|---|---|---|
| fatal | process cannot continue, exiting | critical |
| error | operation failed, needs action (5xx, failed job after retries) | high (critical if data loss) |
| warn | degraded but continuing (retrying, pool saturated, slow query) | medium |
| info | lifecycle events (started, listening, job processed) | low / info |
| debug | verbose diagnostics, dev only | — |

## Implementation notes
- Fastify ships with pino (JSON-lines emitter) built in — **zero new dependencies**: configure its serializers/base fields to match the schema above. Workers: same pino config via the service's existing logger module.
- Expected failures (4xx) log at `info`; unexpected at `error` with stack in the LOG (never in responses) — mirrors error-conventions.md §Logging.
- Do not hand-roll a logger; if Fastify/pino can't express something, raise it with Jim on 'S1-monorepo' before adding deps.
- App-side wiring slice (serializer config in services/api + worker template) is **D1/Jim's** when he picks up app internals; this doc is the contract he implements.

## Log rotation
- Local dev: wired in `infrastructure/docker-compose.dev.yml` — json-file driver, `max-size=10m`, `max-file=3` per container (bounded, no tooling).
- VPS: same caps go into `/etc/docker/daemon.json` at provisioning:
```json
{ "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" } }
```
- journald (Caddy/systemd units) already rotation-managed by journald; do not double-configure.

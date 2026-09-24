# Phase 3 readiness checklist

What this platform still needs real infrastructure/credentials for, exactly
what to hand over, and what already works the moment you do. No live
credentials were available when this was written — everything below was
prepped (config surface, clients, tests) but is unverified against the real
service it talks to.

## 1. Git provider (S3)

- **Need:** a GitHub App or PAT with repo read/webhook-admin scope for each
  org you want to manage, plus a webhook secret.
- **Set:** `GIT_WEBHOOK_SECRET_GITHUB` (infrastructure/.env). Provider
  connections themselves are created through the API (`git.manage`
  permission), not env vars — no per-org env var needed.
- **Ready now:** webhook signature verification, sync logic
  (`apps/api/src/git/sync.ts`), stack detection. Untested against a real
  GitHub webhook delivery.

## 2. WordPress host (S8, S11, S13)

- **Need:** a real (disposable is fine) WordPress site you can install the
  mu-plugin on (`cms/wordpress/mu-plugins/`), reachable from the API host.
- **Set:** nothing globally — the mu-plugin's signing key is provisioned
  per-site as a row in `wp_event_signing_keys` (migration `007_wp_jit.sql`),
  via the API. `S8_WP_EVENT_SECRET` (now in `.env.example`) is a dev-only
  fallback, not the production path.
- **Ready now:** mutation-event ingest (`routes/wp.ts`), JIT grant lifecycle,
  staging state machine + HTTP surface (`routes/staging.ts`). **Not ready:**
  the actual staging provisioner worker that builds a sanitized WP copy —
  `STAGING_PROVISION` jobs are enqueued but nothing consumes them yet.

## 3. Telegram bot (S9)

- **Need:** a bot token from @BotFather, and its webhook pointed at
  `POST /api/v1/telegram/callback`.
- **Set:** `TELEGRAM_BOT_SECRET` (inbound webhook auth — the
  `X-Telegram-Bot-Api-Secret-Token` header) and `TELEGRAM_BOT_TOKEN`
  (outbound sending), both now in `.env.example`.
- **Ready now:** inbound callback verification/authorization/workflow
  dispatch (`routes/telegram.ts`, `telegram/workflows.ts`); outbound
  `TelegramClient.sendMessage` (`packages/shared/src/telegram-client.ts`,
  built this session, unit-tested against a mocked `fetch`, never called
  against the real Bot API). **Not ready:** nothing calls `TelegramClient`
  yet — the PRD's `notification_outbox`/`notification_delivery_attempts`
  durable-delivery tables (§16) don't exist, so there's no retry/queue layer,
  and no call site has been picked (which events should alert — that's a
  product decision, not something to guess).

## 4. External Vaultwarden microservice (S15)

- **Need:** the URL and a service token for the Vaultwarden microservice
  another team operates (PRD §3, §4.2 — this repo never hosts it).
- **Set:** `VAULTWARDEN_BASE_URL`, `VAULTWARDEN_API_TOKEN` (now in
  `.env.example`).
- **Ready now:** `VaultwardenClientStore` (private-API client), wired into
  `GET /api/v1/vaultwarden/:orgId/:key`, unit-tested against a mocked
  `fetch`. Never called against a real Vaultwarden deployment.

## 5. Disposable infra for DR/adversarial drills (S16, S17)

- **Need:** a throwaway VPS or VM you're OK destroying, to run a real
  PostgreSQL restore, management-host rebuild, and trust-revocation drill.
- **Ready now:** backup/WAL chain-integrity helpers (`packages/recovery-host`),
  `wal-receiver` (native `pg_receivewal`), Restic backup/restore scripts
  (`infrastructure/recovery-host/bin/`). **Not ready:** none of this has been
  exercised as a live drill — only unit-tested logic.

## 6. Production-like topology for capacity benchmarks (S18)

- **Need:** a host (or hosts) sized close to what you intend to run in
  production, so `npm run` benchmark tooling has something representative to
  measure — not a dev laptop.
- **Status:** benchmark script referenced in older docs; not verified present
  or runnable in this session. Check before relying on it.

## 7. Final acceptance suite (S19)

- Blocked on 1–6: it's the acceptance pass run against whichever of the above
  are wired up for real, on the topology chosen in #6.

---

Bring any ONE of the above when you have it and say so — each is a bounded,
independently pluggable piece; none require the others to land first.

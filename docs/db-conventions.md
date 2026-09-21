# Database conventions (PostgreSQL)

PostgreSQL is the single durable state plane (PRD hard rule). Apps connect **through PgBouncer** (`DATABASE_URL`, transaction pooling); direct connections (:5433 locally) are for migrations/admin only.

## 1. Migrations

- Forward-only, numbered SQL files: `services/<svc>/migrations/NNN_description.sql` (zero-padded, monotonic, never edited after merge — fix-forward with a new file).
- Applied by the tiny runner `src/db/migrate.ts` in each owning service:
  - takes `pg_advisory_lock` (safe under concurrent deploys),
  - applies pending files in filename order — one transaction for the whole run,
    savepoint per file, all-or-nothing,
  - records them in `platform.schema_migrations`,
  - refuses out-of-order inserts (gap check) — fail loudly instead of guessing.
- Run from empty DB must succeed: `npm run migrate` (CI does this on every PR; see Section-1 validation).
- pg-boss owns its own `pgboss` schema (it self-migrates on boot); never touch its tables directly.

## 2. Transactions

- Multi-statement writes go through `withTx(pool, async (tx) => …)` — one connection, one transaction, rollback on throw. No hand-managed BEGIN/COMMIT.
- Default isolation (READ COMMITTED) unless there's a proven race; if you escalate, comment why at the call site.
- Keep transactions short: no external I/O (HTTP, queue send) inside a tx. Enqueue pg-boss jobs **after** commit (or accept at-least-once semantics and make workers idempotent).

## 3. Idempotency (API writes)

Table per service: `<svc>_idempotency_keys (endpoint, key, request_fingerprint, status_code, response_body, created_at)`.

Flow inside the same tx as the business write:

1. `INSERT INTO …_idempotency_keys` — unique conflict ⇒ fetch existing row.
   - fingerprint matches ⇒ replay stored response (+`Idempotency-Replayed: true` header).
   - fingerprint differs ⇒ `409 CONFLICT`.
2. Perform business write.
3. Store final status+body in the key row; commit. Client gets the real response; replays get the exact bytes back.

Keys are scoped per `(endpoint, key)`; retention: purge rows older than 24h (worker, later section).

## 4. Tables & naming

- Tables are prefixed by owning service (`api_examples`, `api_idempotency_keys`) — cross-service SQL access is forbidden (boundaries in architecture.md).
- snake_case columns; `created_at timestamptz NOT NULL DEFAULT now()` on every table; uuid PKs via `gen_random_uuid()` unless there's a reason.
- Capacity-agnostic policy: no fixed limits in schema; anything sized lives in env-tunable config.

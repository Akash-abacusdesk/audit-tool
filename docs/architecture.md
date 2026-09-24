# Architecture — platform monorepo (S1-D1)

Owner of this record: D1 (jim). Top-level layout below is the agreed map;
each area is owned by its D-agent. Propose changes via god.

## Layout

```
platform/
├── docs/                      # conventions & architecture records
│   ├── architecture.md            # this file (D1/jim)
│   ├── api-conventions.md         # envelopes, versioning, idempotency keys (D1/jim)
│   ├── error-conventions.md       # error codes ↔ HTTP status (D1/jim)
│   ├── db-conventions.md          # migrations, tx, idempotency (D1/jim)
│   ├── cms/                       # WP/headless patterns (D4)
│   ├── scanning/                  # scanner conventions (D3)
│   └── testing/                   # test strategy (D6)
├── packages/
│   └── shared/                # @platform/shared — TS types + zod contracts: API envelopes,
│                              #   error codes, pg-boss job names/payloads. Dep-free except zod. (D1/jim)
├── apps/
│   └── api/                   # @platform/api — Fastify HTTP API; owns migration runner; boots pg-boss (D1/jim)
│       ├── src/
│       └── migrations/        # forward-only numbered SQL files
├── infra/                     # docker dev env: postgres+pgbouncer+boss-smoke; prod/VPS later (D2/pam)
├── scanner/                   # scanner tool inventory (D3/dwight)
└── tsconfig.base.json         # shared strict config; root `npm run build` = tsc -b
```

## Stack

- Node.js + TypeScript (strict), npm workspaces, `tsc -b` project references.
- PostgreSQL = single durable state plane. Apps connect via PgBouncer (transaction pooling);
  direct PG (:5433 host port) is for migrations/admin only.
- pg-boss for queueing/orchestration (schema `pgboss`, same PG instance).
- Fastify for HTTP (chosen S1-D1; not PRD-mandated).

## Module boundaries

- `@platform/shared` is imported by every service/frontend; keep it dep-free except `zod`.
- SQL access lives in services that own their tables (`apps/api` today). No cross-service table access.
- pg-boss job names + payload schemas live in `packages/shared/src/jobs.ts`, so producers (api) and consumers (future workers) stay in sync.

## Environment model (S1)

- Config is env-only (12-factor). Local: copy `infra/.env.example` → `infra/.env`, then
  `docker compose -f infra/docker-compose.dev.yml --env-file infra/.env up -d`
  (root `npm run up`). Services: postgres :5433 (direct), pgbouncer :6432 (apps).
- Capacity knobs are env-tunable per host (capacity-agnostic policy) — see infra/.env.example.
- Secrets are never committed; `.gitignore` covers `.env`.

Refs: build plan §Section 1 lines 96–181; PRD v16 §4–7 topology constraints.


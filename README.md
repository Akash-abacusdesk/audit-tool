# DevSecOps Platform Tool

Monorepo for the DevSecOps platform: Fastify API, Next.js portal, scanner orchestration, worker sandboxing, PostgreSQL/PgBouncer infrastructure, and shared contracts.

## What This Project Does

This tool is a control plane for running DevSecOps work across projects without running heavy or risky security tooling on production application servers.

It provides:

- A backend API for health, auth/RBAC, privileged admin flows, Git integration, scanner ingestion, scheduler state, production control, webhooks, WordPress operations, JIT access, Telegram control, and deep audit queueing.
- A web portal for operators to view findings, vulnerabilities, audit/access state, Git state, onboarding, settings, and design-system primitives.
- A scanner package that runs and normalizes security tools such as Semgrep, Gitleaks, Trivy, WP/CMS checks, package audit adapters, and custom exposure rules.
- A worker runtime that executes scanner jobs in isolated Docker containers with resource limits, read-only inputs, writable output/scratch mounts, and cleanup rules.
- Vaultwarden boundary rules for infrastructure/recovery secrets: scanner workers are explicitly denied direct Vaultwarden access and must receive scoped injected values through the control plane.
- Shared TypeScript/Zod contracts used by API, portal, scanner, and workers to prevent drift.
- A local Docker dev stack with PostgreSQL, PgBouncer, and an optional pg-boss smoke job.

## Requirements

- Node.js 20+ recommended. Node 18+ is the minimum for native `fetch` support used by tests.
- npm, using the lockfile in this directory.
- Docker Desktop or Docker Engine for integration, smoke, scanner-worker, and local database tests.
- PowerShell on Windows examples below; commands also work in normal shells with path syntax adjusted.

## Quick Start

From the repository root:

```powershell
cd tool
npm install
Copy-Item infrastructure\.env.example infrastructure\.env
npm run up
$env:DATABASE_URL='postgres://platform:change-me-long-random@localhost:6432/platform?sslmode=disable'
npm run migrate
npm run dev:api
```

In another terminal:

```powershell
cd tool
npm run dev:portal
```

Default local ports:

- API: `http://localhost:3000` by default.
- Portal: `http://localhost:3001`.
- PostgreSQL direct/admin: `127.0.0.1:5433`.
- PgBouncer app path: `127.0.0.1:6432`.

Apps should use PgBouncer. Direct PostgreSQL is for migrations/admin only.

## Environment Setup

Local configuration lives in `infrastructure/.env` and is not committed.

Create it from the template:

```powershell
Copy-Item infrastructure\.env.example infrastructure\.env
```

Important variables:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: local database credentials.
- `PG_HOST_PORT`: direct PostgreSQL host port, default `5433`.
- `BOUNCER_HOST_PORT`: PgBouncer host port, default `6432`.
- `DATABASE_URL`: required by the API and migration command; app traffic should point at PgBouncer.
- `ADMIN_NETS`, `ADMIN_STEPUP_*`: privileged admin access controls.
- `AUDIT_EXPORT_KEY`, `AUDIT_SPOOL_DIR`: audit export settings.
- `GIT_WEBHOOK_SECRET_GITHUB`, `WEBHOOK_*`: webhook ingress settings.

The committed `.env.example` contains development-safe placeholders only. Replace secrets for any real environment.

## Common Commands

Run these from `tool/`.

| Command | Purpose |
|---|---|
| `npm install` | Install workspace dependencies. |
| `npm run build` | TypeScript project build via `tsc -b`. |
| `npm run clean` | Clean TypeScript build outputs. |
| `npm test` | Run Vitest suite. |
| `npm run test:integration` | Run integration driver. Starts/checks required services where scripted. |
| `npm run test:smoke` | Full clean-stack smoke test. Boots compose, API, pg-boss path, tests, then tears down. |
| `npm run validate:recovery-host` | Validate the Security / Recovery Host Vaultwarden compose config. |
| `npm run up` | Start local PostgreSQL + PgBouncer. |
| `npm run down` | Stop local compose services. |
| `npm run migrate` | Run API database migrations. |
| `npm run dev:api` | Start API in watch mode. |
| `npm run dev:portal` | Start portal on port `3001`. |

Vaultwarden is not started by `npm run up`. The local compose stack only runs PostgreSQL, PgBouncer, and the optional pg-boss smoke container. Vaultwarden is planned as part of the separate Security / Recovery Host, not the local app database stack.

Package-specific commands:

```powershell
npm run build -w @platform/api
npm run build -w @platform/portal
npm run build -w @platform/scanner
npm run dev -w @platform/api
npm run dev -w @platform/portal
```

## Running Tests

### Fast Local Checks

```powershell
npm run build
npm test
```

### Integration Tests

```powershell
npm run test:integration
```

Integration tests cover real service boundaries such as PostgreSQL through PgBouncer, pg-boss, API behavior, scanner adapters, worker runtime behavior, and selected security flows.

### Smoke Test

```powershell
npm run test:smoke
```

Smoke is the highest-confidence local gate. It starts a clean compose stack, boots the API, waits for `/readyz`, checks pg-boss through PgBouncer, runs smoke specs, and tears the stack down.

### Live Scanner Worker Test

Some scanner-worker tests are gated because they require Docker images and Docker container execution.

```powershell
$env:RUN_SCANNER_INTEGRATION='1'
npx vitest run tests/integration/scanner/worker.integration.test.ts
```

Required local scanner images:

- `devsecops/scanner-semgrep:1.86.0`
- `devsecops/scanner-gitleaks:v8.18.4`
- `devsecops/scanner-trivy:0.55.0`

Build them when missing:

```powershell
docker build -t devsecops/scanner-semgrep:1.86.0 scanner/images/semgrep
docker build -t devsecops/scanner-gitleaks:v8.18.4 scanner/images/gitleaks
docker build -t devsecops/scanner-trivy:0.55.0 scanner/images/trivy
```

Run this test serially. It creates Docker resources with fixed scan IDs, so concurrent runs can collide.

## Running The Local Stack

Start database services:

```powershell
npm run up
```

Check status:

```powershell
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env ps
```

Run the pg-boss one-shot proof:

```powershell
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env --profile smoke up --build --exit-code-from boss-smoke boss-smoke
```

Stop services:

```powershell
npm run down
```

Full reset, including data volume:

```powershell
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env down -v
```

## Repository Layout

```text
tool/
  apps/
    api/                 Fastify API, migrations, pg-boss startup, routes, services
    portal/              Next.js operator portal
  packages/
    shared/              Shared contracts, job schemas, errors, RBAC/security types
    scanner/             Scanner registry, adapters, normalization, ingestion helpers
    worker-runtime/      Docker worker execution and isolation runtime
    stack-detect/        Filesystem/manifest stack detector
    prodctl/             Production control primitives
    prodcomms/           Production communication primitives
    recovery-host/       Recovery-host plan, integrity, and freshness helpers
  infrastructure/        Local Docker Compose stack and boss-smoke proof
  scanner/               Scanner image Dockerfiles, profiles, tool manifests, abuse docs
  cms/                   WordPress/CMS support material
  cms-fixtures/          CMS fixture data
  tests/                 Unit, integration, smoke, acceptance, and fixtures
  docs/                  Architecture, ops, security, frontend, CMS, scanning docs
```

## Main Modules

### `apps/api`

Fastify service that owns the current durable backend state and migrations.

Key areas:

- `src/server.ts`: server construction and route registration.
- `src/main.ts`: runtime entrypoint.
- `src/config.ts`: environment parsing and defaults.
- `src/db/`: PostgreSQL pool and migration runner.
- `src/plugins/pgboss.ts`: pg-boss integration.
- `src/routes/`: HTTP API surface.
- `src/auth/`: passwords, RBAC/privileged admin, audit helpers.
- `src/git/`: Git/GitHub sync and credential encryption.
- `src/scheduler/`: queue admission and scheduling classes.
- `src/deep-audit/`: deep audit queueing.
- `src/prod/`: production control route/service layer.
- `src/telegram/`: Telegram control workflows.

Route groups include health, examples, auth, admin, secrets, security, webhooks, Git, scanning, scheduler, production control, WordPress, JIT, Telegram, and deep audit.

### `apps/portal`

Next.js App Router frontend for operators.

Key areas:

- `src/app/layout.tsx`: root layout.
- `src/app/(portal)/layout.tsx`: authenticated portal shell.
- `src/app/(portal)/*/page.tsx`: dashboard pages such as findings, vulnerabilities, audit, access, Git, JIT, onboarding, settings, and design.
- `src/components/ui/`: local design-system primitives.
- `src/components/shell/`: sidebar, topbar, user chip.
- `src/lib/`: API/auth helpers.

The portal imports shared contracts instead of backend internals.

### `packages/shared`

Shared TypeScript contracts used across apps and packages.

It contains API envelopes, error codes, job names/payload schemas, scanner contracts, RBAC/security policy types, Git contracts, JIT contracts, Telegram contracts, update state, stack detection types, and deep audit contracts.

Vaultwarden-related policy currently lives here too, in `src/secrets.ts`. `VAULTWARDEN_KEY_PREFIX`, `assertNotDirectVaultwarden`, and scoped secret retrieval rules enforce that scanner workers cannot request Vaultwarden secrets directly.

Keep this package small. It should remain dependency-light because every app consumes it.

### `packages/scanner`

Scanner orchestration and normalization code.

Key responsibilities:

- Defines scanner registry entries and invocation commands.
- Runs scanner jobs through `@platform/worker-runtime`.
- Converts native output into platform findings.
- Provides adapters for Semgrep, Gitleaks, Trivy, PHPCS, composer/package audit, WP vulnerability intelligence, and cross-stack/CMS exposure rules.
- Keeps severity normalization near the adapter so downstream code receives a consistent model.

Scanner conventions are documented in `docs/scanning/SCANNING-CONVENTIONS.md`.

### `packages/worker-runtime`

Runs untrusted or heavy jobs in Docker containers.

The runtime is responsible for:

- Read-only workspace mounts.
- Writable output and scratch mounts.
- CPU, memory, PID, disk, and timeout limits.
- Network mode selection.
- Cancellation and teardown.
- Preventing orphaned containers/workspaces after failure.

Security details live in `docs/security/worker-runtime-isolation.md`.

### `packages/stack-detect`

Pure TypeScript stack detector for scanned repositories.

It identifies stacks such as Next.js, WordPress, Payload, Directus, and Strapi from files/manifests, and marks headless combinations when a frontend framework coexists with a CMS.

### `packages/prodctl` and `packages/prodcomms`

Small production-control and production-communication packages. They hold reusable primitives used by the API without pulling production-specific logic into unrelated packages.

### `packages/recovery-host`

Pure TypeScript recovery-host helpers for Section 15: hardened host plan validation, Vaultwarden isolation flags, backup/WAL/Vaultwarden hash-chain records, integrity verification, and backup freshness status.

### `infrastructure`

Local Docker environment:

- `postgres`: PostgreSQL 17.
- `pgbouncer`: transaction-pooling path used by apps.
- `boss-smoke`: optional one-shot job proving pg-boss works through PgBouncer.

More detail: `docs/ops/docker-dev-env.md`.

Vaultwarden is intentionally absent from this compose file. It belongs to the Security / Recovery Host described in the PRD/build plan, with an isolated datastore and separate validation path.

### Vaultwarden And Secrets

Vaultwarden is the intended secrets service for infrastructure and recovery secrets. It is deployed from `infrastructure/recovery-host/`, not from the local dev compose stack.

Current repo-owned implementation:

- `infrastructure/recovery-host/docker-compose.yml`: deployable Vaultwarden service for the Security / Recovery Host.
- `infrastructure/recovery-host/.env.example`: production env template.
- `infrastructure/recovery-host/backup.env.example`: Restic backup/restore env template.
- `infrastructure/recovery-host/Caddyfile.private.example`: optional private reverse proxy template.
- `infrastructure/recovery-host/bin/backup-recovery-host.sh`: encrypted backup entrypoint for Vaultwarden data, received backups, and WAL.
- `infrastructure/recovery-host/bin/verify-recovery-backups.sh`: backup verification entrypoint.
- `infrastructure/recovery-host/bin/restore-vaultwarden.sh`: restore entrypoint for Vaultwarden material.
- `packages/shared/src/secrets.ts`: defines the Vaultwarden key prefix and denial policy.
- `apps/api/src/routes/secrets.ts`: applies the denial policy on scoped secret reads.
- Scanner workers must not connect to Vaultwarden or receive standing Vaultwarden credentials.
- Trusted control-plane code may retrieve scoped values and inject only the minimum secret needed for a job.

Planned topology from the PRD/build plan:

- Vaultwarden runs on the Security / Recovery Host.
- It uses its own isolated datastore.
- It is not routed through the central PgBouncer/PostgreSQL app path.
- Scanner workers are validated to have no direct Vaultwarden path.

Validate the deployable config:

```powershell
npm run validate:recovery-host
```

### `tests`

Test tree with unit, integration, smoke, acceptance, and fixtures.

Important fixture groups:

- `tests/fixtures/repos/`: stack and scanner fixtures.
- `tests/fixtures/security/`: security-specific vulnerable/clean fixtures.
- `tests/fixtures/headless/`: headless CMS/frontend examples.

## How The System Works

### Request/API Flow

1. A client calls the Fastify API.
2. The route validates input using shared contracts or local schemas.
3. The service reads/writes PostgreSQL through PgBouncer.
4. Long-running work is queued through pg-boss after database commits.
5. Responses use the shared API envelope shape so portal/tests can rely on consistent success and error formats.

### Scanner Flow

1. A scan request is created through the API or test harness.
2. Scanner selection is resolved by `packages/scanner` from the registry and target type.
3. The scanner package creates a worker spec for `packages/worker-runtime`.
4. Worker runtime starts a Docker container with `/workspace` read-only and `/out` writable.
5. The scanner writes raw output to `/out`.
6. Scanner adapters normalize raw JSON/SARIF into platform findings.
7. Findings are ingested with stable fingerprints to make retries idempotent.

If a scanner needs a secret, it receives a scoped injected value from the control plane. It never receives Vaultwarden credentials and never talks to Vaultwarden directly.

### Worker Isolation Flow

1. The runtime creates a per-job workspace/output area.
2. Docker starts with resource limits and restricted mounts.
3. The job exits, times out, or is cancelled.
4. The runtime collects outputs and removes containers/networks/workspaces.

Heavy scanner jobs must not run on production VPSs that serve live sites. They run centrally or on isolated ephemeral workers.

### Database Flow

1. Migrations live in `apps/api/migrations` and are forward-only numbered SQL files.
2. The API migration runner applies missing migrations.
3. App connections go through PgBouncer.
4. Direct PostgreSQL is reserved for migrations/admin work.
5. pg-boss uses the same PostgreSQL instance for job state.

### Portal Flow

1. Next.js serves the operator portal on port `3001`.
2. Pages render through the portal shell and local design-system primitives.
3. Portal data access should go through its `src/lib` API helpers.
4. Portal code should consume `@platform/shared` contracts, not API implementation files.

## Build And Release Notes

- Root `npm run build` uses TypeScript project references.
- Portal builds with Next.js via `npm run build -w @platform/portal`.
- Scanner images are built from `scanner/images/<tool>/Dockerfile`.
- Tool versions and resource profiles are documented under `scanner/tools.json`, `scanner/profiles.json`, and `docs/scanning/SCANNING-CONVENTIONS.md`.

## Troubleshooting

### `could not find pgbouncer: not found`

This usually means Docker Desktop tried to start stale compose resources instead of the current repo compose definition.

Use the repo compose file directly:

```powershell
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env --profile smoke down --remove-orphans
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env up -d --wait
```

Then verify:

```powershell
docker compose -f infrastructure/docker-compose.dev.yml --env-file infrastructure/.env ps
```

### Port Already In Use

Change `PG_HOST_PORT` or `BOUNCER_HOST_PORT` in `infrastructure/.env`, then restart compose.

### Smoke Fails On Missing Env Values

Recreate local env from the template and replace any real secrets as needed:

```powershell
Copy-Item infrastructure\.env.example infrastructure\.env
```

### Scanner Integration Skips Or Fails

- Set `RUN_SCANNER_INTEGRATION=1`.
- Ensure Docker is running.
- Build the required local scanner images.
- Run the scanner integration spec serially.

### Typecheck Fails Only In A Dirty Shared Checkout

Validate from a clean worktree before assuming the branch is broken. This repo may have local generated files or hive work in progress.

## Deeper Docs

- `docs/architecture.md`: top-level architecture and module boundaries.
- `docs/api-conventions.md`: API envelope and idempotency conventions.
- `docs/db-conventions.md`: migration and database rules.
- `docs/error-conventions.md`: error code and HTTP status rules.
- `docs/testing/test-strategy.md`: test tiers and smoke strategy.
- `docs/ops/docker-dev-env.md`: local Docker services.
- `docs/scanning/SCANNING-CONVENTIONS.md`: scanner contracts, severity mapping, and runtime profiles.
- `docs/security/worker-runtime-isolation.md`: worker runtime hardening.
- `docs/frontend/architecture.md`: portal architecture and design system.
- `docs/cms/README.md`: CMS and WordPress integration docs.

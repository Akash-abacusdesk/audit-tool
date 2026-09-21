# Testing Strategy — S1-D6

Owner: Oscar (D6 QA/Automation) · Status: **strategy approved-shape, code pending** · Conversation: `S1-foundation`

Deliverable mapping (build plan `6_Developer_Task_Distribution_Capacity_Agnostic.md`):

| Card item (lines 157–162) | Where it lands |
|---|---|
| Unit/integration testing framework | Vitest workspace config + tier layout below |
| Acceptance-test organization | `tests/acceptance/` (API-level in S1) |
| CI test structure | Pipeline stages below (runner wired later) |
| Environment smoke tests | `tests/smoke/` + one-command entry |

Section validation this must satisfy: lines 163–169 (clean-env build, empty-DB migrations,
Portal/API + PostgreSQL + PgBouncer + pg-boss up together, smoke pass, conventions exercised
by ≥1 endpoint). Exit condition: lines 171–180.

## Tooling decisions

- **Runner: Vitest** — TS-native, workspace-aware, zero-config for monorepos. Boring-mainstream
  default. *Switch rule:* if D1's skeleton standardizes on Jest, D1 wins; we re-point configs, tiers stay identical.
- **Assertions/mocks:** Vitest built-ins. No chai/sinon/jest plugins.
- **HTTP calls in tests:** native `fetch` (Node ≥18). No supertest unless D1's API app already ships it.
- **Browser/E2E (Playwright): OUT OF SCOPE for S1** per dispatch boundary — arrives in a later section.
  S1 "acceptance" means black-box through the public API only.
- Everything else deliberately not added: no contract-testing framework, no load tools, no visual regression.

## Tier layout

```
platform/
  apps|packages/*/src/**/*.test.ts   # UNIT — colocated with source
  tests/
    integration/                     # INTEGRATION — real PG via PgBouncer, pg-boss, API process
    acceptance/                      # ACCEPTANCE — black-box, public API only, full composed stack
    smoke/                           # SMOKE — clean-state boot proof (Section validation driver)
```

| Tier | Talks to | Gate |
|---|---|---|
| Unit | nothing real (pure logic, mappers, validators) | every commit; target <10s |
| Integration | Postgres (through PgBouncer), pg-boss, local API | pre-merge / CI stage |
| Acceptance | composed stack, public API surface | CI main |
| Smoke | entire stack from zero | S1 validation (lines 163–169) |

Rules:
- Unit tests never touch network/DB/db-mocked-with-fakes counts as integration, not unit.
- Integration tests own their fixtures; they assume compose services are up (script below guarantees it).
- One `*.test.ts` file per behavior cluster; no shared mutable state between files.

## Conventions-exercised requirement (validation line 169)

The smoke suite includes ≥1 request against a real endpoint asserting the shared **error envelope**
(D1's error conventions) plus one happy-path response — proving API/error contracts are live, not
just documented.

## Environment model (aligned with D2's Docker dev env — as built)

- Stack: `infrastructure/docker-compose.dev.yml` (project `platform-dev`): **postgres** (127.0.0.1:5433,
  migrations/admin only), **pgbouncer** (127.0.0.1:6432, apps connect here), one-shot **boss-smoke**
  profile proving a pg-boss job round-trip through the bouncer.
- Readiness: compose healthchecks + `up --wait`; tests additionally poll `/readyz`
  (= PG reachable via PgBouncer AND pg-boss started).
- Migrations run inside API boot against whatever `DATABASE_URL` points at; smoke points it through
  PgBouncer to prove app-path works end to end. Explicit CLI when needed: `npm run migrate -w @platform/api`.
- Config via `infrastructure/.env` (seeded from `.env.example` by the smoke script if missing); local values only.

## One command (DoD — implemented)

```
npm run test:smoke     # repo root; safe from clean state, wipes volumes on exit
```

`scripts/smoke.mjs`: compose up -d --wait → boot API (`tsx services/api/src/main.ts`, migrates empty DB,
starts pg-boss + reference worker) → poll `/readyz` ≤60s → boss-smoke round-trip profile →
`vitest run tests/smoke` → teardown (`down -v`). Fail-fast, non-zero exit on any step.

Smoke suite (`tests/smoke/stack.smoke.test.ts`) asserts: `/healthz` live + x-request-id echo;
`/readyz` ready; POST example happy path 201 envelope; idempotency-key replay (same row +
`Idempotency-Replayed` header); VALIDATION_ERROR 422 envelope with requestId and no stack/SQL leak;
NOT_FOUND for unknown resource and unrouteable route in identical shape; created row durable via GET.
That satisfies validation line 169 (conventions exercised by ≥1 endpoint) several times over.

## CI test structure (documented now; runner attached later)

Stages, fail-fast, artifacts (logs + results) uploaded on failure:

1. **install** — lockfile-frozen
2. **static** — lint + typecheck (`npm run build`)
3. **unit** — `npm test` (tests/unit; passWithNoTests until first unit specs land)
4. **integration** — compose services up → tests/integration
5. **smoke** — full clean-env stack → `npm run test:smoke`

Trigger: PRs + main. Shape is runner-agnostic; a future `ci.yaml` merely encodes these stages.

## As-built notes (phase 2)

- Vitest 3.x as root devDependency; `vitest.config.ts` includes only tests/unit + tests/integration —
  smoke is script-driven. `tests/` sits outside `tsc -b` references so builds stay clean.
- Toolchain verified locally: `tsc -b` green, vitest runs. **Stack verification blocked by host env:
  Docker Desktop's Linux engine has no WSL distribution installed (all server calls return 500).**
  Needs human/admin fix (likely the already-pending reboot); rerun `npm run test:smoke` afterwards.

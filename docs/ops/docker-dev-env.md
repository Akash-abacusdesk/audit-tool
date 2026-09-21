# Local Docker dev environment

Scope: S1-D2. Stack lives at `tool/infrastructure/docker-compose.dev.yml`.

## Services
| Service | Image | Host port | Notes |
|---|---|---|---|
| postgres | `postgres:17-alpine` | 127.0.0.1:5433 | Direct access for migrations/admin only |
| pgbouncer | `edoburu/pgbouncer:latest` | 127.0.0.1:6432 | Transaction pooling; apps connect here |
| boss-smoke | built from `infrastructure/boss-smoke/` | — | One-shot pg-boss round-trip check (`--profile smoke`) |

## Boot from clean state
```powershell
cd tool/infrastructure
Copy-Item .env.example .env      # then edit POSTGRES_PASSWORD
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml --profile smoke up --build --exit-code-from boss-smoke boss-smoke
```
Exit code 0 from `boss-smoke` = PG + PgBouncer + pg-boss verified together.
Teardown / full reset: `docker compose -f docker-compose.dev.yml down -v` (`-v` wipes data).

## Connection strings
- App traffic (through bouncer): `postgres://platform:<pw>@localhost:6432/platform?sslmode=disable`
- Migrations/admin (direct): `postgres://platform:<pw>@localhost:5433/platform?sslmode=disable`

## Conventions
- **Secrets**: real values only in `infrastructure/.env` (gitignored); `.env.example` is the committed template. See [caddy-secrets.md](caddy-secrets.md).
- **Capacity-agnostic**: every limit is an env knob (`PG_MAX_CONNECTIONS`, `BOUNCER_*`, …) with dev-sized defaults. Never hardcode sizing; tune per environment via env vars.
- **Ports on localhost only**: nothing listens on 0.0.0.0 by default.
- PgBouncer runs `transaction` mode with `SERVER_RESET_QUERY=DISCARD ALL`. If a component needs session features (LISTEN/NOTIFY across sessions, session advisory locks), connect it directly to PG:5433 and document why here.

## Upgrade path
- Pin image tags when D6 adds CI (currently major-tag pins for reproducibility with low tag-drift risk).

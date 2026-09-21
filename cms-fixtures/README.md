# S6-D2 — CMS fixture runtime + CI egress (D2 / pam)

Enables Oscar's **S6-D6** live cross-stack validation to run on CI. Mirrors the
S5 scanner packaging (`tool/scanner/`) + `SCANNING-CONVENTIONS.md` §5.2 egress matrix.

## What this provides

- **CMS fixture container images** for the four Section-6 families, built per-repo
  (per Oscar's contract, 2026-08-27):
  - `cms-payload-basic` (Payload admin API, :3000)
  - `cms-directus-basic` (Directus, :8055, sqlite)
  - `cms-strapi-basic` (Strapi, :1337, sqlite)
  - `cms-headless-next-payload` (Next.js frontend + Payload backend, :3100)
  - `cms-headless-next-wordpress` (Next.js frontend, :3200) + `cms-wordpress`
    (WordPress PHP backend, :8080, mysql sidecar)
- **`platform-api`** service that waits for postgres, runs **ALL migrations
  (incl `006_scan_findings`)**, then boots — so D3/D4 findings persist to the sink.
- **`ci-egress-allowlist.sh`** — default-deny floor on `iptables DOCKER-USER`
  (mirrors §5.2). S6-D6 detection needs **no external egress**; only
  `api.wpvulndb.com` is sanctioned, and only when `WPVULNDB_ENABLED=1`.
- **`docker-compose.ci.yml`** — wires postgres + mysql + api + the 5 CMS fixtures
  on a bridge network. Apply the egress allowlist on the CI host before `up`.

## Build / run (CI)

```bash
cd tool/cms-fixtures
cp ci/.env.example ci/.env          # adjust secrets
# optional: pin base digests
#   docker build --build-arg NODE_DIGEST=@sha256:... -f images/cms-payload-basic/Dockerfile ../tests/fixtures/repos/payload-basic
bash ci-egress-allowlist.sh         # install default-deny floor on CI runner
docker compose -f docker-compose.ci.yml --env-file ci/.env up --build
```

## S6-D6 scan volume

Oscar's `tool/tests/fixtures/headless/` (the seeded `NEXT_PUBLIC_*` leaks) is mounted
read-only into the `api` service at `/fixtures/headless` so his battery can scan it.
The `api` image carries the monorepo + node, so the battery runs there:

```bash
docker compose -f docker-compose.ci.yml run api node tests/fixtures/headless-validate.mjs
```

(The `repos/` images above are stack-detection parity; `headless/` is what carries the
intentional client-secret exposures the cross-stack gate must catch.)

## Notes / ceilings (ponytail)

- Base-image digests are resolved + recorded in `build-record.json` at first CI
  build (no Docker/network here to verify live). `NODE_DIGEST`/`WP_DIGEST` build-args.
- Node CMS images run non-root (`USER 10001`, `chown -R` cwd so sqlite/cache write).
- WordPress uses the official image (`www-data`); `wp-content` comes from
  `repos/headless-next-wordpress`.
- `headless/` Next fixtures (Oscar's unit oracle) can be volume-mounted into the
  scanner runner for image parity; the `repos/` packages above are the running backends.
- Out of scope (per Oscar): migration 006 lives in the `platform-api` service, not
  the fixture images. Section 7 untouched.

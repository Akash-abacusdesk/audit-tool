# Headless CMS Integration Patterns

Supported headless stacks per PRD 2.1(2) line 50: Payload CMS, Directus, Strapi, plus WordPress
used as a headless backend (pattern W2). Detection signals live in
[`platform/cms/signatures.json`](../../cms/signatures.json); this doc defines the integration shape.

## Common rules (all headless stacks)

- **Relationship metadata**: a Next.js frontend consuming an external CMS/API is labeled `headless`
  with explicit frontend/backend relationship metadata; multi-label projects are expected
  (PRD lines 554-556). Ambiguous repos → `manual_review_required` (line 558).
- **Cross-stack gates**: coupled frontend/backend pairs get API-boundary checks applied from the
  relationship metadata without manual per-repo configuration (PRD line 51).
- **DB isolation**: CMS instances use their own least-privilege DB identity on the central PG
  service — never a shared superuser (§17.1 lines 1335-1346). PgBouncer pool class per §17.2.
- **Secrets**: runtime injection only (§17.3 lines 1370-1379). Admin/bootstrap credentials are
  never shared permanent credentials.
- **Off-production scanning**: SAST/SCA/secrets/deep-audit run centrally from repo + artifacts,
  never on the production host (§3 lines 91-92, §4.3).

## H1 — Payload CMS

Self-hosted Node/TypeScript app (`payload` dep, `payload.config.*`, collections/globals — PRD
lines 534-539).

- Deployed as a Node app artifact behind Caddy; config-as-code in the repo is the source of truth.
- Content model changes ship as reviewed code (collections/globals), so schema migration evidence
  rides the normal deployment record.
- REST/GraphQL endpoints exposed to frontend; admin UI restricted to JIT-granted operators.

## H2 — Directus

Self-hosted Node app (`directus` / `@directus/*` deps, SDK usage, endpoint config — PRD lines
541-546).

- Schema/data-model lives in Directus; snapshot the data-model definition into the repo as the
  reviewable artifact and deploy via artifact + wrapper command, mirroring W1's flow.
- Role/permission changes inside Directus count as privileged mutations and must be attributable
  (actor, grant/session ID, request ID — actor-attribution rules §10 lines 900-911 apply by analogy;
  signed event parity with WP MU-plugin is the target state, implementation deferred out of S1).

## H3 — Strapi

Node app (`@strapi/*` deps, `config/api.*`/`config/server.*` layout — PRD lines 548-552).

- Content-type definitions are code → same artifact-based deploy as H1.
- Admin panel access follows the same JIT boundary as WP admin (no shared permanent admin
  passwords, 2.1(5)).

## H4 — WP-backed headless (see pattern W2)

WordPress REST/GraphQL consumed by Next.js. WP side obeys all WordPress patterns; the frontend
obeys this doc's common rules.

## What is explicitly NOT defined here

- No Kubernetes/orchestrator assumptions (non-goal, §3 line 87) — all stacks deploy as plain
  app artifacts/services behind Caddy.
- No always-on browser/scanner processes attached to any stack (§3 lines 88-90).

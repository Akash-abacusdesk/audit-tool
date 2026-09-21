# CMS / WordPress Platform Patterns — S1-D4 (definitions only)

Scope: Section 1 definition work. No WP instances, no MU-plugin implementation, no live
integrations in this section. This folder defines *how* supported stacks are deployed and
integrated; `platform/cms/signatures.json` is the machine-readable companion consumed by
stack detection and the shared types package.

## Documents

| Doc | Covers |
|---|---|
| [wp-deployment-patterns.md](wp-deployment-patterns.md) | WordPress deployment patterns (traditional + headless backend role), artifact flow, inventory/mutation-event surface |
| [headless-integration-patterns.md](headless-integration-patterns.md) | Payload / Directus / Strapi / WP-as-CMS headless integration patterns, relationship metadata, cross-stack gates |
| [wp-remote-control-boundaries.md](wp-remote-control-boundaries.md) | What the central plane may command on production WP hosts, JIT interplay, hard "no" list |

## Sources of truth

- Build plan: `6_Developer_Task_Distribution_Capacity_Agnostic.md:144-149` (this task).
- PRD: `Unified_DevSecOps_Platform_PRD_v16_Capacity_Agnostic.md`
  - 2.1(2) stack-aware gates, explicit Payload/Directus/Strapi support — lines 48-51
  - 2.1(4) safe updates — lines 57-61; 2.1(5) zero-trust JIT — lines 63-65
  - §3 non-goals (no deep workloads on prod) — lines 80-100
  - §4.3 production-host boundary — lines 208-235
  - §7.1 stack detection signals — lines 516-559
  - §9.2 restricted command wrapper — lines 854-884
  - §10 mutation observability — lines 888-911
  - §11 one-time redemption JIT — lines 915-943
  - §12.3 hostile-production-site controls — lines 988-1006
  - §15 safe update engine — lines 1218-1289
  - §17 secrets & DB isolation — lines 1333-1379

## Coordination notes

- Monorepo layout owned by Jim (S1-D1, conversation `S1-monorepo`). When shared TS types land,
  `signatures.json` stack ids (`wordpress`, `nextjs`, `payload`, `directus`, `strapi`, `headless`)
  should map 1:1 into that package; flag mismatches in `S1-monorepo`.
- Deployment/infra mechanics (compose, Caddy, secrets injection) are Pam's S1-D2 surface;
  this folder only references them.
- Scanner-side consumption of signatures is Dwight's S1-D3; signatures.json carries detection
  signals only, no scanner-result schema.

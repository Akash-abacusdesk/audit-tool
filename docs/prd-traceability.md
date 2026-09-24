# PRD Traceability

Source: `../Unified_DevSecOps_Platform_PRD_v16_Capacity_Agnostic.md` and `../6_Developer_Task_Distribution_Capacity_Agnostic.md`.

Status meanings:

- `implemented`: repo contains runnable code/config and tests or validation command.
- `partial`: repo contains contracts, docs, mocks, or partial runtime code, but not the full PRD behavior.
- `missing`: no deployable implementation found in this checkout.

## Current Truth

**Scope change:** Vaultwarden and the Task Portal (Next.js UI) are no longer part of this platform. Both are external microservices reached only through private API calls (PRD §3, §4.2). `apps/portal` still exists in this repo but is excluded from completion accounting below pending extraction to its own repo.

The project is not yet 100% PRD-complete. Recent audit found the build was silently broken (stale `dist`/`.tsbuildinfo` cache masked 20 TypeScript errors; S11 staging and S14 deep-audit routes were unreachable — never registered on the server, and `packages/shared` was missing the staging module entirely). This has been fixed: clean build passes, 313/313 unit tests pass, and S11/S14 routes are now wired into `server.ts`. A private-API client to the external Vaultwarden microservice now exists (`packages/shared/src/vaultwarden-client.ts`), and Vaultwarden hosting has been stripped from `infrastructure/recovery-host` in favor of real PostgreSQL WAL reception (`pg_receivewal`).

Remaining gaps are largely live-infrastructure/live-tool work that cannot be verified in a dev sandbox: real Semgrep/Lynis/testssl/ZAP/ClamAV execution behind the deep-audit mock adapters, live WordPress staging validation, capacity benchmarking, and DR drills.

## Section Map

| PRD/build-plan area | Status | Evidence | Remaining work |
|---|---|---|---|
| S1 Core platform foundation | implemented | `apps/api`, `apps/portal`, `packages/shared`, `infrastructure/docker-compose.dev.yml`, smoke tests | None known beyond production rollout hardening. |
| S2 Auth, RBAC, audit | implemented | `apps/api/src/auth`, `routes/auth.ts`, `routes/admin.ts`, `routes/security.ts`, `tests/unit/authz-matrix.test.ts` | Keep production audit export scheduled on real host. |
| S3 Project, Git, stack intelligence | implemented | `routes/git.ts`, `routes/webhooks.ts`, `packages/stack-detect`, stack fixtures | Real provider credentials/prod webhook deployment. |
| S4 Scheduler and worker platform | partial | `routes/scheduler.ts`, `packages/worker-runtime`, scanner abuse tests | Linux host egress enforcement and live worker topology validation. |
| S5 Core security scanning | implemented | `packages/scanner`, scanner adapters, findings route, live scanner integration gate | Registry/image publishing and production worker deployment. |
| S6 Headless/cross-stack security | implemented | scanner cross-stack rules and fixtures | None known beyond adding new CMS patterns as needed. |
| S7 Safe production control | partial | `packages/prodctl`, `routes/prod.ts`, abuse tests | Real production wrapper install, service account, host-side allow-list files. |
| S8 WordPress monitoring and JIT | partial | `cms/wordpress/mu-plugins`, `routes/wp.ts`, `routes/jit.ts`, tests | Live WordPress deployment validation and temporary-session proof on real WP. |
| S9 Telegram operations | partial | `routes/telegram.ts`, shared contracts, tests | Real bot webhook/token deployment and notification preferences wiring. |
| S10 WP vulnerability/update intelligence | implemented | WP inventory, WP advisory correlation, vulnerability UI helpers/tests | Replace fixture advisory feed with production feed when approved. |
| S11 Safe staging environment | partial | `packages/shared/src/staging.ts` (state machine + safety gate), `apps/api/src/staging/queue.ts`, `apps/api/src/routes/staging.ts` — now registered and tested (`tests/unit/s11-staging*.test.ts`) | Real ephemeral WP container provisioning, PII sanitizer execution, integration neutralization on real staging (orchestration layer is real; the provisioner worker behind `STAGING_PROVISION` is not). |
| S12 Functional/visual validation | partial | browser-heavy limiter, validation UI/docs | Real Playwright worker, screenshots, masks, visual diff persistence. |
| S13 Safe WP update engine | partial | update state model, update APIs/UI, promotion primitives | Full staged update execution, health check, promotion, rollback against real WP. |
| S14 Deep security/posture audit | partial | 4/7 stages now real: `RealCodeSastAdapter` (Semgrep+Gitleaks), `RealHostLynisAdapter` (Lynis), `RealTlsNetworkAdapter` (testssl.sh), `RealStagingZapAdapter` (ZAP) — all reuse `@platform/scanner`'s registry/worker-runtime path against the already-built `devsecops/scanner-{semgrep,gitleaks,lynis,testssl,zap}` images (scanner/build-record.json). Pipeline itself is now true per-stage pg-boss jobs, chained, idempotent, registered as a live worker in main.ts. | cms-advisory (WPScan/advisory — packages/scanner has WP intel, not wired) and artifact-malware (no scanner image yet) still mocked. Nothing here has run against real Docker this session — unit-tested only (mocked runScan); verify against live containers before trusting findings. |
| S15 Security/Recovery infrastructure | partial | `infrastructure/recovery-host` (WAL reception via `pg_receivewal`, Restic backup/restore scripts), `packages/recovery-host`, `packages/shared/src/vaultwarden-client.ts` (private-API client), `apps/api/src/routes/secrets.ts` (`/vaultwarden/:orgId/:key`) | Live restore drill; the private-API client is unit-tested against a mocked fetch but not against a real Vaultwarden deployment (owned by the external team). |
| S16 Disaster recovery/compromise response | partial | docs/tests reported in hive history, some recovery scripts now present | Execute live PostgreSQL restore, management rebuild, Vaultwarden recovery, trust revocation drill. |
| S17 Threat-model validation/hardening | partial | threat-model docs/tests reported in hive history | Run live adversarial drills for cases that cannot be unit-tested. |
| S18 Capacity benchmarking/sizing | partial | benchmark script and capacity package reported in hive history | Run representative production benchmarks and select final host sizes/concurrency. |
| S19 Production readiness | partial | checklist/tests reported in hive history | Final acceptance suite on selected production topology. |
| S20 AI remediation | partial | AI remediation routes/package reported in hive history | Real provider secrets/network policy, UI flow, full prompt-injection/secret-leak live validation. |

## Release-Blocking Gap Queue

1. Make Section 15 operational: approve and implement the real Vaultwarden scoped-secret retrieval model, WAL receiver, and live restore drill. Vaultwarden stores encrypted vault data; do not fake server-side plaintext retrieval without an approved service-account/decryption design.
2. Make Section 12/14 operational: Playwright worker, visual artifact storage, ZAP staging-only runner, Lynis clone runner, malware artifact runner.
3. Make Section 11/13 operational against real WordPress staging/update/promotion/rollback.
4. Run Section 16 recovery drills on disposable infrastructure.
5. Run Section 18 representative benchmarks and write the selected production capacity profile.
6. Run Section 19 production-readiness acceptance suite against that topology.

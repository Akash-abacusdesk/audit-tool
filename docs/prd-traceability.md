# PRD Traceability

Source: `../Unified_DevSecOps_Platform_PRD_v16_Capacity_Agnostic.md` and `../6_Developer_Task_Distribution_Capacity_Agnostic.md`.

Status meanings:

- `implemented`: repo contains runnable code/config and tests or validation command.
- `partial`: repo contains contracts, docs, mocks, or partial runtime code, but not the full PRD behavior.
- `missing`: no deployable implementation found in this checkout.

## Current Truth

**Scope change:** Vaultwarden and the Task Portal (Next.js UI) are no longer part of this platform. Both are external microservices reached only through private API calls (PRD §3, §4.2). `apps/portal` has been removed from the repo entirely.

The project is not yet 100% PRD-complete, but is substantially further along than earlier snapshots of this doc claimed. Fixed this session: a silently broken build (stale dist/.tsbuildinfo cache masked 20 TypeScript errors), S11/S14 routes that existed with tests but were never registered on the server, and a deep-audit pipeline redesigned from enqueue-all-7-upfront-with-a-monolithic-rerun to true per-stage pg-boss jobs (chained, idempotent, crash-safe resume).

All 7 S14 deep-audit stages are now real (not mocked), and actually verified against live Docker this session, not just unit-tested: Semgrep, Gitleaks, Lynis, testssl.sh, ZAP, and a new ClamAV scanner image were all run for real. That verification caught and fixed one real bug (the testssl.sh adapter assumed the wrong JSON shape). S11/S14/S15's stores are now PostgreSQL-backed (api_staging_runs, api_deep_audit_runs, api_secrets -- migration 009), verified with real inserts/transitions against live Postgres. Private-API clients exist for the external Vaultwarden and Telegram services. Vaultwarden hosting has been stripped from infrastructure/recovery-host in favor of real PostgreSQL WAL reception (pg_receivewal).

Remaining gaps are genuinely live-infrastructure/credential work: real WordPress/Telegram/Git-provider/Vaultwarden endpoints, DR drills, capacity benchmarking, and the S11 staging provisioner worker (state machine is real; nothing yet builds the actual sanitized WP copy). See docs/ops/phase3-readiness.md.

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
| S11 Safe staging environment | partial | `packages/shared/src/staging.ts` (state machine + safety gate), `apps/api/src/staging/queue.ts`, `apps/api/src/routes/staging.ts` — registered, tested, and now backed by `PgStagingStore` (api_staging_runs, migration 009) instead of in-memory — real inserts/transitions/illegal-transition-refusal verified against live Postgres this session | Real ephemeral WP container provisioning, PII sanitizer execution, integration neutralization on real staging (orchestration + persistence layer is real; the provisioner worker behind `STAGING_PROVISION` is not). |
| S12 Functional/visual validation | partial | browser-heavy limiter, validation UI/docs | Real Playwright worker, screenshots, masks, visual diff persistence. |
| S13 Safe WP update engine | partial | State machine (update-state.ts) previously had zero test coverage and no wiring. Now: `UpdateOrchestrator`, `PgUpdateStore` (api_update_units, migration 010, verified against live Postgres), `POST /update-units`, `POST /update-units/:id/transition`, `GET /update-units/:id`, gated on new `update.manage` permission. Enqueues real pg-boss jobs (update.snapshot/stage/promote) only after the state machine accepts the transition. | Real staged update execution (restore point creation, staging validation kickoff, production promotion) against actual WordPress — needs a real WP host (Phase 3). Orchestration/persistence layer is real; the worker consumers for update.snapshot/stage/promote don't exist yet (same "orchestration real, execution deferred" pattern as S11). |
| S14 Deep security/posture audit | implemented | **All 7 stages real**, every one verified against a live Docker container this session (not just unit-tested): `RealCodeSastAdapter` (Semgrep+Gitleaks — real scan of vuln-secrets fixture), `RealCmsAdvisoryAdapter` (in-process WP inventory/advisory correlation — real inventory file), `RealHostLynisAdapter` (real `audit system` run, 36 findings), `RealTlsNetworkAdapter` (real scan of example.com, 42 findings — a real adapter bug was found+fixed here), `RealStagingZapAdapter` (real quick-scan of example.com, 11 findings), `RealArtifactMalwareAdapter` (new `devsecops/scanner-clamav` image, real EICAR FOUND + clean OK both confirmed). Pipeline is true per-stage pg-boss jobs, chained, idempotent, registered as a live worker in main.ts; integration-tested against real Postgres+pg-boss. | None outstanding for this section's own scope — trivy (used elsewhere, not S14) has an image built but its vuln-DB download didn't finish in this sandbox's slow network, unverified live. |
| S15 Security/Recovery infrastructure | partial | `infrastructure/recovery-host` (WAL reception via `pg_receivewal`, Restic backup/restore scripts), `packages/recovery-host`, `packages/shared/src/vaultwarden-client.ts` (private-API client), `apps/api/src/routes/secrets.ts` (`/vaultwarden/:orgId/:key`) | Live restore drill; the private-API client is unit-tested against a mocked fetch but not against a real Vaultwarden deployment (owned by the external team). |
| S16 Disaster recovery/compromise response | partial | docs/tests reported in hive history, some recovery scripts now present | Execute live PostgreSQL restore, management rebuild, Vaultwarden recovery, trust revocation drill. |
| S17 Threat-model validation/hardening | partial | threat-model docs/tests reported in hive history | Run live adversarial drills for cases that cannot be unit-tested. |
| S18 Capacity benchmarking/sizing | partial | benchmark script and capacity package reported in hive history | Run representative production benchmarks and select final host sizes/concurrency. |
| S19 Production readiness | partial | checklist/tests reported in hive history | Final acceptance suite on selected production topology. |
| S20 AI remediation | partial | Was 0% despite prior doc claims (audited this session — no route/package existed). Now built end to end: `AnthropicRemediationProvider` (packages/shared/src/ai-provider.ts, provider abstraction + one real implementation + redaction), `POST /findings/:id/remediate` + `GET /remediation-requests/:id` (gated on new `finding.remediate` permission, developer/team_lead/manager), `api_ai_remediation_requests` (migration 011, PG-backed store verified against live Postgres), wired into the scheduler's existing `ai_remediation` workload class (was registered but never dispatched to). Fails closed with no provider configured. Disabled by default (`SCHED_AI_REMEDIATION_DISABLED`), matching its pre-existing "registered but never enabled" design intent. | No real Anthropic API key exercised this session (client is unit-tested against a mocked fetch only). PRD §8.4 steps 5-8 (write to an isolated working branch, run lint/test/security checks, human review, PR creation) are out of scope here — they need a live Git provider connection (Phase 3); this covers steps 1-4 (request → context gathering → job → provider call → stored proposal for review). |

## Release-Blocking Gap Queue

1. Make Section 15 operational: approve and implement the real Vaultwarden scoped-secret retrieval model, WAL receiver, and live restore drill. Vaultwarden stores encrypted vault data; do not fake server-side plaintext retrieval without an approved service-account/decryption design.
2. Make Section 12/14 operational: Playwright worker, visual artifact storage, ZAP staging-only runner, Lynis clone runner, malware artifact runner.
3. Make Section 11/13 operational against real WordPress staging/update/promotion/rollback.
4. Run Section 16 recovery drills on disposable infrastructure.
5. Run Section 18 representative benchmarks and write the selected production capacity profile.
6. Run Section 19 production-readiness acceptance suite against that topology.

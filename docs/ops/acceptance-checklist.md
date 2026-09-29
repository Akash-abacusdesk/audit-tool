# Production Acceptance Checklist (Section 19 / PRD §23)

Source: PRD §23 "Acceptance Criteria" — 35 items. This document maps each
one to real evidence in this repo (test file, live drill, or code
reference), and marks honestly which ones genuinely need Phase 3
infrastructure (a real production topology, real load) that this session's
sandbox doesn't have.

No prior version of this document existed before 2026-09-28 (see
docs/prd-traceability.md, S19).

Automated subset: `scripts/acceptance-suite.mjs` runs the checks marked
**[auto]** below live against a running API instance. The rest are marked
**[doc]** (verified by reading code/existing tests, not re-run by the
script) or **[skip]** (needs Phase 3 infrastructure this repo doesn't
provision).

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Representative benchmark/load/security tests completed, capacity decision documented | **[skip]** | `scripts/benchmark.mjs` is the tool (built + live-verified 2026-09-28); a real capacity *decision* needs production-shaped load, not a dev sandbox run |
| 2 | No deep scanner on live production website VPSs | **[doc]** | `scanner/tools.json` `runs_on` never includes a production-website tag; worker-runtime only ever targets ephemeral Docker workers it creates itself — no code path deploys a scanner onto a managed site |
| 3 | Critical API/PostgreSQL latency within thresholds under approved load | **[skip]** | Needs the real approved concurrent workload profile (Phase 3) |
| 4 | Admission policy prevents resource exhaustion/starvation | **[doc]** | `tests/unit/admission.test.ts` (passing, part of the 380-test suite) |
| 5 | Weekly deep audits use central/ephemeral capacity only | **[doc]** | S14 pipeline is pure pg-boss ephemeral-worker jobs (`deep-audit/queue.ts`) |
| 6 | WP updates validated in sanitized staging before promotion | **[doc]** | S11/S12/S13 — live-verified this session (real staging provision → functional check → promote) |
| 7 | Production remote access restricted to allow-listed operations | **[doc]** | `tests/unit/s7-d6-prodctl.test.ts`, `s7-d6-contract.test.ts` (passing) |
| 8 | JIT credentials one-time, hashed at rest, POST-redeemed, auto-revoked | **[auto]** | Live-drilled S16 AND `scripts/acceptance-suite.mjs` — replay rejected (409), double-revoke rejected (404) |
| 9 | Telegram privileged callbacks replay-protected, re-authorized server-side | **[doc]** | `UNIQUE(bot_id, delivery_id)` + fresh `authorizeTelegramCallback` re-read every call |
| 10 | Break-glass override requires the defined authorization path | **[doc]** | JIT `approve` requires `jit.approve` (separate from `jit.request`); `assertNotSelf` blocks self-approval |
| 11 | PostgreSQL recovery succeeds from the Security/Recovery Host (Vaultwarden out of scope) | **[doc]** | Live-drilled S16 (`infrastructure/recovery-host/bin/restore-drill.sh`) — 3s restore, zero data loss |
| 12 | Quarterly recovery/access-control drills documented and repeatable | **[doc]** | `docs/security/compromise-response-runbook.md` + `restore-drill.sh` (self-cleaning, re-runnable on demand); the *quarterly cadence* itself is an ops scheduling matter, not code |
| 13 | Staging can't start without capacity/storage/DB-health/admission checks | **[doc]** | Staging jobs route through the same admission-gated workload classes as everything else (`scheduler.ts`) |
| 14 | Browser concurrency from benchmark evidence; workers auto-terminate on timeout | **[skip/doc]** | Auto-termination exists (`worker-runtime` timeout/kill + orphan sweeper, live-verified prior session); concurrency *from benchmark evidence* needs Phase 3 numbers |
| 15 | Retained artifacts/screenshots pushed to object storage per TTL/quota | **[gap]** | **Not implemented** — `staging/validate.ts` screenshots persist to local disk only; no object-storage integration or TTL/quota policy exists anywhere in the repo |
| 16 | Stalled workers detected by heartbeat/timeout; pg-boss capacity reclaimed | **[doc]** | Orphan sweeper (`startOrphanSweeper`) + pg-boss `expireInSeconds` per workload class |
| 17 | PgBouncer load tests demonstrate availability during scan-ingestion bursts | **[skip]** | Needs real burst load (Phase 3); pgbouncer config itself is real (`infrastructure/docker-compose.dev.yml`) |
| 18 | Backup/WAL freshness monitoring within RPO | **[gap]** | Restore mechanism is real and live-drilled (S16), but no automated freshness-monitoring/alerting exists — nothing watches WAL lag and pages on drift |
| 19 | RBAC enforcement verified for all 5 roles | **[auto]** | `tests/unit/authz-matrix.test.ts` (full sweep, all roles × all permissions) — also re-asserted live in `acceptance-suite.mjs` |
| 20 | No self-approval for critical break-glass actions | **[auto]** | `assertNotSelf` (code) + live-checked in `acceptance-suite.mjs` |
| 21 | Weekly WP audits correlate versions against vuln intel | **[doc]** | S10 `wp-vuln-intel` correlation engine, existing tests |
| 22 | Lynis on approved clones/images only, no routine deep-scan load on live sites | **[doc]** | S14 `RealHostLynisAdapter` runs on ephemeral workers only |
| 23 | TLS/network posture checks non-destructive, rate-limited, bounded, auditable | **[doc]** | testssl.sh adapter is a bounded quick-scan; findings flow through the same audit trail as everything else |
| 24 | WPScan/Lynis/TLS/AI-remediation use explicit workload classes; `ai_remediation` disabled until Level 5 | **[auto]** | `scheduler/classes.ts` — verified live in `acceptance-suite.mjs` (`SCHED_AI_REMEDIATION_DISABLED` default) |
| 25 | Workload-class concurrency/exclusion configurable and validated against selected topology | **[skip]** | Configurable (env overrides) — real; validation *against the selected production topology* needs that topology to exist (Phase 3) |
| 26 | RBAC default-deny when no binding/permission matches | **[auto]** | `permissionsFor()` returns an empty set by construction; asserted in `authz-matrix.test.ts` and `acceptance-suite.mjs` |
| 27 | Management plane documented/operated as Tier-0 infrastructure | **[doc]** | `docs/security/compromise-response-runbook.md`, `docs/ops/security-recovery-host.md` |
| 28 | Scanner workers: no Vaultwarden access, no Docker socket, no standing prod creds, destroyed after jobs | **[doc]** | `docs/security/worker-runtime-isolation.md`; zero-leftover-container teardown verified live in prior sessions |
| 29 | Production webhooks can't invoke arbitrary central commands | **[doc]** | `routes/wp.ts` only records events into Postgres — no execution surface |
| 30 | Tested compromise runbook can revoke the management plane from production hosts | **[doc]** | `docs/security/compromise-response-runbook.md` — JIT revoke + emergency lockdown live-drilled S16; SSH-key/firewall/rebuild steps are inherently ops actions |
| 31 | PostgreSQL outage is fail-closed for deployments, JIT, approvals, new dispatch | **[auto]** | **Live-drilled 2026-09-28**: stopped Postgres+pgbouncer, confirmed login and JIT-request both fail with a hard error (not a silent success), restarted, confirmed recovery |
| 32 | Vaultwarden/security-host outage doesn't stop production sites serving traffic | **[doc]** | Architectural: production sites never depend on this control plane to serve their own traffic; Vaultwarden is reached only via an optional private-API call |
| 33 | AI remediation excluded from V1: user-triggered, scoped, audited, non-deploying | **[auto]** | Re-asserted in `acceptance-suite.mjs`: `SCHED_AI_REMEDIATION_DISABLED` default, human-trigger-only route |
| 34 | One Security/Recovery system provisions Vaultwarden isolation + backup/recovery, absent a benchmark-justified split | **[skip]** | Topology decision — needs Phase 3 infrastructure to make |
| 35 | Selected CPU/RAM/storage/topology recorded as an operational capacity profile, not an immutable requirement | **[skip]** | Needs S18's real numbers and a real topology decision first |

## Summary

- **[auto]** (live-verified by `scripts/acceptance-suite.mjs`, 2026-09-28): 8, 19, 20, 24, 26, 31, 33 (7 items)
- **[doc]** (verified by code/existing test reference, not independently re-run): 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 16, 21, 22, 23, 27, 28, 29, 30, 32 (19 items)
- **[gap]** (genuinely missing, not built): 15 (object-storage retention), 18 (backup-freshness monitoring/alerting) (2 items)
- **[skip]** (needs Phase 3 real infrastructure/load/topology, not buildable in this sandbox): 1, 3, 14 (concurrency-from-evidence clause), 17, 25 (topology-validation clause), 34, 35 (7 items, 2 partially split with [doc])

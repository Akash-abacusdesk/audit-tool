# Product Requirement Document (PRD) v16.0
# Capacity-Agnostic DevSecOps Control Plane with Off-Production Scanning, JIT Access, Safe Updates & Telegram Operations

**Document Version:** 16.0.0  
**Status:** Approved Architecture Baseline  
**Capacity Policy:** No fixed production VPS CPU/RAM ceiling is imposed before implementation. The platform is built with configurable resource controls and telemetry; production sizing and concurrency ceilings are selected after representative benchmark, load, security, staging, and recovery tests.  
**Primary Design Principle:** **No security scanners or deep-audit workloads run on production VPSs that serve live websites.** Production hosts provide only tightly scoped metadata, deployment signals, mutation events, health checks, and controlled deployment actions. All analysis runs on the central management VPS or on ephemeral isolated workers attached to it.  
**Performance Positioning:** Production capacity is an evidence-based operational decision made after the platform is sufficiently complete to benchmark representative workloads. Cost, throughput, latency, resilience, and isolation are balanced using measured data rather than a preselected VPS size.

---

## 1. Executive Summary

The platform provides a centralized internal DevSecOps control plane for managing WordPress and Next.js projects hosted across production VPSs.

The platform is deliberately **capacity-agnostic during implementation**. No fixed CPU/RAM ceiling is used as a product-design requirement. The architecture remains lean, measurable, and horizontally extensible so the team can benchmark representative workloads after the core platform is built, then choose the production VPS sizes and worker topology required to meet the service objectives.

The platform uses:

- Native Node.js **pg-boss** orchestration running entirely on PostgreSQL.
- PostgreSQL as the single durable state plane for application data, job queues, orchestration state, workload concurrency, and recovery.
- An external Vaultwarden microservice, outside this platform's scope, reached only through private API calls for infrastructure and recovery secrets.
- An external Task Portal microservice, outside this platform's scope, that renders findings/tasks/operational UI by consuming this platform's private API. This platform is headless: it owns no operator-facing UI.
- Lightweight per-PR security checks.
- Ephemeral scanner workers created only when work exists.
- Serialized weekly deep-audit stages.
- Ephemeral WordPress staging for update validation.
- Remote production hosts that do **not** execute deep scanners.

The product prioritizes:

1. Stability of the central control plane.
2. No deep security scanning or browser-based testing on live production hosts; production-side collection is lightweight, bounded, asynchronous, and resource-limited.
3. Safe and auditable WordPress update workflows.
4. Fast-enough developer feedback rather than maximum CI throughput.
5. Strong JIT access and privileged-operation controls.
6. Simple infrastructure that a small engineering team can operate.

---

## 2. Product Objectives

### 2.1 Core Objectives

1. **Developer Task Management API**
   - Expose security findings, operational tasks, update failures, and remediation work through a private API for the external Task Portal microservice to render as Kanban/table views.
   - Project assignment, ownership, severity, due date, and status tracking as data owned by this platform; presentation is out of scope.

2. **Stack-Aware Security Gates**
   - Automatically detect Next.js/TypeScript, traditional WordPress/PHP, and modern headless CMS architectures.
   - Explicitly support Payload CMS, Directus, and Strapi alongside WordPress.
   - Detect coupled frontend/backend project relationships and apply cross-stack API-boundary checks without manual per-repository configuration.

3. **Centralized Off-Production Scanning**
   - Run all SAST, SCA, secrets detection, malware inspection, browser testing, and deep audits away from the production hosts.
   - Use Git repositories, build artifacts, deployment manifests, sanitized staging snapshots, and centrally retrieved evidence as scan inputs.

4. **Safe WordPress Updates**
   - Validate updates in an ephemeral sanitized staging copy.
   - Update one plugin or compatible dependency group at a time.
   - Run smoke, functional, and visual tests before controlled production promotion.
   - Preserve rollback points and compatibility history.

5. **Zero-Trust JIT Access**
   - Developers do not receive shared permanent WordPress administrator passwords.
   - Temporary access grants are short-lived, attributable, revocable, and task/project scoped.

6. **Telegram Operations**
   - Telegram provides alerts, approvals, reminders, and request initiation.
   - Telegram alone never authorizes a final production break-glass override.

7. **Actor Attribution**
   - Privileged actions are correlated to authenticated platform identity, project, session, JIT grant, request ID, approval context, actor IP, and application identity.

8. **Resilience**
   - Maintain a small independent recovery node for PostgreSQL continuity. Vaultwarden's own continuity/recovery is owned by the external Vaultwarden microservice, outside this platform's scope.
   - Preserve a recovery path even if the management VPS fails.

---

## 3. Explicit Non-Goals

The initial production baseline does **not** include:

- Jenkins.
- DefectDojo.
- Mandatory SonarQube.
- Kubernetes.
- Always-on Playwright.
- Always-on ZAP.
- Always-on malware scanners.
- Deep scanners running on production website servers.
- Intrusive exploitation or destructive DAST against production endpoints.
- Full Lynis/host benchmark scanning on live customer-serving hosts outside approved maintenance procedures.
- Running WPScan as a heavyweight scanner on live production hosts; WordPress vulnerability correlation is performed centrally from collected version inventory.
- Intrusive TLS/network exploitation against production endpoints; production-facing TLS/network checks are external, non-destructive, rate-limited posture assessments only.
- Direct Telegram authorization of production security overrides.
- Shared permanent WordPress admin-password distribution.
- Multi-region active-active operation.
- Hosting, operating, or backing up Vaultwarden. Vaultwarden is an external microservice reached only through private API calls; this platform never stores Vaultwarden's vault data or runs its datastore.
- Hosting the developer-facing Task Portal UI. The portal is an external microservice that consumes this platform's private API; this platform ships no operator-facing frontend.

SonarQube or other commercial analysis platforms may be added later if measured needs justify their operational cost.

---


## 4. Infrastructure Topology

### 4.0 Tier-0 Classification

The central management plane is classified as **Tier-0 infrastructure** because it can influence deployments, access grants, scanner execution, security findings, project metadata, and production-control workflows across the managed fleet.

Tier-0 requirements:

- no routine developer SSH access,
- dedicated administrative identities,
- MFA for privileged administration,
- hardware-backed authentication where practical,
- restricted inbound management interfaces,
- outbound egress allow-listing where practical,
- minimal OS package footprint,
- host firewall default-deny,
- immutable or append-only export of privileged audit events,
- intrusion-detection/host-monitoring controls,
- emergency credential-rotation procedure,
- documented compromise-recovery runbook,
- production trust revocable independently of the management VPS.



### 4.1 Central Management Plane

The central management plane hosts the trusted control-plane services. **Its production CPU, RAM, and local-storage size are intentionally TBD during implementation.**

Required components:

- Caddy or equivalent ingress/TLS termination.
- API (headless control plane; no bundled operator UI — the Task Portal is an external microservice that consumes this API).
- PostgreSQL.
- pg-boss orchestration.
- PgBouncer.
- Workload Admission Controller.
- Monitoring/telemetry required for post-build capacity measurement.

The implementation must support either:

1. **co-located ephemeral workers** on the management host when measured capacity and isolation policy allow it, or
2. **separate worker VPSs/pools** when security, throughput, concurrency, or resource measurements justify separation.

No production sizing decision is considered final until representative benchmarks are complete.

```text
                         CENTRAL MANAGEMENT PLANE
                       Production size: benchmark-derived
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│  Caddy           API            PostgreSQL / pg-boss               │
│                  │                     │                            │
│                  └──── Workload Admission Controller ────────────┐ │
│                                                                  │ │
└───────────────────────┬───────────────────────────────┬────────────┘
                        │                               │
                        │ dispatch                      │ restricted
                        ▼                               │ SSH/HTTPS
               EPHEMERAL WORKER CAPACITY               ▼
             co-located and/or separate VPSs     PRODUCTION VPSs
             size/count: benchmark-derived       Live websites only
                        │                         NO deep scanners
                        │
                        ▼
              SECURITY / RECOVERY HOST
               size: benchmark-derived
              PostgreSQL backups/WAL
                 + recovery tooling

  External microservices (out of scope, private-API-only):
    - Vaultwarden secrets service
    - Task Portal operator UI
```

### 4.2 Security / Recovery Host

Vaultwarden is out of scope for this platform: it is an external microservice, operated and recovered independently, reached only through private API calls. This platform never runs a Vaultwarden datastore.

**This is the same physical/logical Security / Recovery Host referenced later in Section 18. Its CPU, RAM, and storage ceiling are not fixed in advance. Production sizing is selected after backup, WAL, restore, retention, and recovery benchmarks are measured.**

Responsibilities:

- PostgreSQL backup/WAL reception for the central control-plane database,
- recovery tooling,
- backup integrity verification,
- emergency credential-rotation material,
- recovery runbooks.

Required placement properties:

- separate failure domain from the management plane where practical,
- independent administrative credentials,
- encrypted storage,
- private authenticated connectivity,
- capacity sufficient to satisfy the defined RPO/RTO after measurement.

The control-plane API retrieves only narrowly scoped secrets, over a private API call to the external Vaultwarden microservice, required for the specific project/action.

Scanner workers:

- do not connect directly to Vaultwarden,
- do not inherit broad platform secrets,
- receive only task-scoped short-lived credentials when absolutely required.

The security/recovery host is not used for CI, staging, Playwright, Lynis, Semgrep, ZAP, malware analysis, AI remediation, or Vaultwarden hosting.

### 4.3 Production-Host Boundary

Production VPSs are application-serving systems, not security-worker nodes.

Allowed production-side activities:

- Serve WordPress/Next.js traffic.
- Emit deployment metadata.
- Emit signed WordPress mutation events from the MU-plugin.
- Provide health/readiness endpoints.
- Return narrow inventory metadata such as current application version, plugin list, core version, and deployment ID.
- Accept allow-listed update/deployment commands through a restricted remote-command wrapper.
- Produce normal application/runtime logs.
- Participate in existing backup/snapshot processes.

Not allowed:

- Semgrep scans.
- Deep Gitleaks history scans.
- Trivy filesystem sweeps.
- ClamAV/Maldet full-site scans.
- OWASP ZAP execution.
- Playwright browsers.
- Repository-wide SAST.
- Weekly deep-audit workers.
- Defect normalization/AI remediation processing.
- Unrestricted Docker daemon access from the management plane.

---


### 4.4 PostgreSQL as Tier-0 State Plane

PostgreSQL is the single durable application/orchestration state plane and is therefore treated as Tier-0.

It stores:

- application state,
- pg-boss queue state,
- job retries/timeouts,
- authorization and approval state,
- audit metadata,
- findings,
- deployment/update records,
- JIT-access records.

Required controls:

- dedicated PgBouncer pools by traffic class,
- strict connection ceilings,
- WAL shipping,
- scheduled backup verification,
- corruption/integrity monitoring,
- replication/backup freshness alerting,
- tested restore,
- documented degraded-mode behavior.

Redis is not introduced solely to create datastore diversity.

## 5. Resource Model & Post-Build Capacity Discovery

The platform does **not** assume a production CPU/RAM ceiling during implementation.

The resource model exists to ensure every significant service and workload is measurable, limitable, and relocatable before production sizing is chosen.

### 5.1 Required Resource Instrumentation

Measure at minimum:

- CPU utilization and throttling by service/workload,
- memory working set and peak usage,
- OOM/kill events,
- disk usage and temporary-workspace growth,
- disk I/O throughput and I/O wait,
- PostgreSQL latency, connections, locks, and transaction pressure,
- PgBouncer pool saturation,
- pg-boss queue depth and queue wait,
- job runtime by workload class,
- browser/staging startup and teardown cost,
- artifact size and retention growth,
- worker failure/retry rates.

Always-on services and workers still use configurable resource limits. These limits are **operational configuration**, not hard-coded product assumptions.

### 5.2 Capacity Benchmark Suite

Before production sizing is approved, execute representative benchmarks for:

1. idle/control-plane baseline,
2. normal API usage,
3. standard PR security jobs,
4. full repository/history security scan,
5. sanitized WordPress staging creation,
6. Playwright functional/visual validation,
7. ZAP staging assessment,
8. artifact/malware inspection,
9. deep-audit pipeline,
10. backup/WAL and restore activity,
11. approved concurrent-workload scenarios.

Capture:

- p50/p95/p99 latency where applicable,
- CPU peak and sustained utilization,
- memory peak and sustained utilization,
- disk/I/O consumption,
- PostgreSQL impact,
- queue wait/runtime,
- failure/retry behavior.

### 5.3 Production Sizing Decision

Only after benchmark evidence exists should the team decide:

- central management-plane VPS size,
- Security / Recovery Host size,
- whether worker compute is co-located or dedicated,
- worker VPS size/count,
- per-class concurrency,
- staging concurrency,
- Playwright/browser concurrency,
- storage capacity and object-storage policy,
- operating reserve/headroom.

The selected capacity must meet service objectives with documented safety margin.

### 5.4 Dynamic Admission Rules

Admission checks remain mandatory regardless of hardware size.

A heavy or staging workload may start only when:

- current host/pool capacity is within configured safety thresholds,
- PostgreSQL is within configured health thresholds,
- required temporary disk capacity is available,
- no recovery operation requires exclusive capacity,
- workload-isolation rules permit execution.

Threshold values are derived from benchmark/production telemetry and remain configurable.

### 5.5 Snapshot & Temporary-Storage Guard

A production database, filesystem snapshot, checkout, build artifact, or staging copy must never consume unbounded local resources.

Before provisioning, the scheduler estimates required temporary capacity. If the workload would violate configured storage or memory safety margins, the system must:

- use an approved reduced/sanitized dataset where technically valid,
- dispatch to additional worker/storage capacity,
- or defer/reject the job.

No single project may exhaust the control plane or worker pool through unbounded temporary storage.

## 6. Workload Admission Controller

The scheduler is required for safety, fairness, responsiveness, and future scaling, but its concurrency values are **not fixed to a preselected VPS size**.

### 6.1 Enforcement Layers

**Layer 1 — Container/OS controls**

- configurable CPU limits/weights,
- configurable memory limits,
- PID limits,
- I/O controls where available,
- worker-level concurrency,
- lifecycle/time limits.

**Layer 2 — pg-boss workload orchestration**

The API uses **pg-boss** as the native Node.js orchestration engine. Queue state, job state, retries, timeouts, and concurrency state live in PostgreSQL.

No additional queue datastore or separate locking datastore is required.

Each job records at minimum:

- project,
- environment,
- workload class,
- enqueue/start/completion timestamps,
- target worker/pool,
- timeout policy,
- retry count,
- terminal state,
- resource/benchmark telemetry references.

### 6.2 Workload Classes

| Class | Examples | Concurrency Policy |
|---|---|---|
| `critical_interactive` | API authorization, user-facing callbacks/control operations | Reserved priority; must not be starved by background work |
| `standard_pr` | Gitleaks diff, Semgrep diff, SCA, tests | Benchmark-derived/configurable |
| `browser_heavy` | Playwright validation | Benchmark-derived/configurable |
| `cpu_heavy` | full Semgrep/repository audit | Benchmark-derived/configurable |
| `hardening_scan` | Lynis against approved image/clone | Benchmark-derived/configurable |
| `io_heavy` | large artifact/file analysis, malware inspection | Benchmark-derived/configurable |
| `staging_heavy` | ephemeral WordPress staging | Benchmark-derived/configurable |
| `ingestion_heavy` | large finding/artifact import | Benchmark-derived/configurable |
| `network_light` | testssl.sh, certificate/header/port posture checks | Benchmark-derived/configurable |
| `vuln_intel` | WPScan version/advisory correlation and CMS advisory lookups | Benchmark-derived/configurable |
| `ai_remediation` | developer-triggered scoped LLM patch generation | Disabled until Level 5; later bounded by local + provider policy |

Vaultwarden is not part of scanner-worker scheduling and remains on the Security / Recovery Host.

### 6.3 Capacity-Aware Concurrency

Concurrency is configuration, not architecture.

The platform must support:

- per-class concurrency limits,
- per-worker/pool capacity,
- class priorities,
- cross-class exclusions where required,
- reserved capacity for `critical_interactive`,
- per-project fairness,
- queue backpressure,
- worker/pool drain mode.

Initial production values are selected only after the benchmark suite in Section 5.

Cross-class rules may differ depending on topology. Two workloads that must be mutually exclusive when sharing one worker may safely run concurrently when assigned to physically separate worker pools.

Security isolation requirements are never relaxed merely because more CPU/RAM is available.

### 6.4 Scanner Worker Isolation Boundary

Every ephemeral scanner/build/test worker is treated as **hostile-code execution infrastructure**.

Mandatory controls:

- unprivileged identity,
- no Docker socket access,
- no privileged mode,
- read-only base image where feasible,
- ephemeral writable workspace,
- configurable CPU/memory/PID limits,
- no direct Vaultwarden access,
- no standing production credentials,
- no access to unrelated worker namespaces/workspaces,
- restricted outbound access,
- no public inbound listener,
- per-job temporary credentials only,
- automatic destruction,
- artifact export before destruction,
- timeout/watchdog enforcement.

Project code must never be able to pivot into:

- the host Docker daemon,
- PostgreSQL administrative credentials,
- Vaultwarden,
- production SSH credentials,
- unrelated repositories,
- another worker.

### 6.5 Backpressure

New background work is delayed, redirected to another worker pool, or rejected when configured safety thresholds are exceeded, including:

- CPU saturation,
- memory pressure,
- I/O pressure,
- PostgreSQL latency,
- insufficient free storage,
- queue saturation,
- recovery/failover activity.

Critical interactive control-plane responsiveness takes precedence over background throughput.

### 6.6 Worker Watchdog & Job Reclamation

Every ephemeral worker must implement:

- periodic heartbeat,
- pg-boss timeout/expiration,
- hard execution timeout,
- graceful termination window,
- forced kill after grace period,
- maximum retry count,
- orphaned-workspace cleanup,
- stalled-job reclamation.

The scheduler records:

- start time,
- last heartbeat,
- termination reason,
- retry count,
- cleanup status,
- resource telemetry,
- reclamation/retry event.

### 6.7 Playwright Concurrency Policy

Playwright remains ephemeral.

Browser/page parallelism and worker count are benchmark-derived and configurable.

Regardless of final capacity:

- browser workers have hard timeout and cleanup,
- dynamic elements are normalized/masked where practical,
- screenshots/results are exported before worker destruction,
- browser workloads cannot starve critical interactive services,
- additional browser capacity should preferably be added through isolated worker compute when concurrency demand grows.

## 7. Stack Detection & Per-Deploy Security Gates

### 7.1 Automatic Stack Detection

Projects are classified using repository indicators, package manifests, framework configuration, deployment metadata, and API relationships.

**Next.js / TypeScript signals**

- `next` dependency in `package.json`
- `next.config.*`
- TypeScript/JavaScript source layout
- server/client component usage and public runtime configuration

**Traditional WordPress signals**

- `wp-config.php`
- WordPress plugin/theme structure
- `composer.json` plus PHP source
- deployment metadata indicating WordPress target

**Payload CMS signals**

- `payload` package dependency
- `payload.config.*`
- collections/globals definitions
- Payload REST/GraphQL endpoints or generated types

**Directus signals**

- `directus` / `@directus/*` packages
- Directus SDK usage
- Directus REST/GraphQL endpoint configuration
- deployment metadata identifying a Directus backend

**Strapi signals**

- `@strapi/*` dependencies
- `config/api.*`, `config/server.*`, or Strapi project layout
- Strapi REST/GraphQL SDK or endpoint usage

**Headless / Decoupled Architecture detection**

When a Next.js frontend consumes WordPress REST/GraphQL, Payload, Directus, Strapi, or another external CMS/API, the project is marked `headless` with explicit frontend/backend relationship metadata. A project may therefore have multiple stack labels instead of a single binary type.

Ambiguous projects are marked `manual_review_required`.

### 7.2 Standard PR Gate

Initial latency objective: **95% of standard PR gates complete within 5 minutes**, validated against the production capacity selected after benchmarking. If the target is not met, adjust worker capacity or concurrency rather than shifting scan load to production hosts.

Next.js:

- TypeScript compile/check.
- ESLint security/correctness rules.
- Semgrep targeted rules.
- Gitleaks diff scan.
- Trivy/npm/pnpm dependency scan.
- Unit tests as configured.

Traditional WordPress:

- PHPCS/WPCS.
- Semgrep PHP security rules.
- Gitleaks diff scan.
- Composer audit where applicable.
- Plugin/theme policy checks.
- Unit/integration tests where available.

Payload / Directus / Strapi:

- Semgrep rules tailored to Node.js/TypeScript backend exposure.
- Dependency SCA.
- secrets scanning.
- authentication/authorization configuration checks where statically verifiable.
- GraphQL/REST endpoint policy checks.
- admin/backend exposure checks.

### 7.3 Cross-Stack Security Gate

Headless projects receive an additional boundary check between the presentation layer and CMS/API backend. The gate verifies that:

- privileged GraphQL/REST API secrets are not included in browser/client bundles,
- only explicitly public configuration is exposed through `NEXT_PUBLIC_*` or equivalent client-visible mechanisms,
- server-only CMS credentials are used only in server-side code paths,
- frontend code does not embed admin tokens, service tokens, private API keys, or unrestricted CMS credentials,
- CORS/origin assumptions are reviewed against the declared deployment topology,
- GraphQL/REST endpoint URLs and authentication modes match the project policy,
- generated client bundles are scanned for known secret patterns before promotion.

A confirmed privileged CMS secret in a client-side bundle is a non-overridable deployment blocker.

### 7.4 Ephemeral PR Workers

Workers are ephemeral:

```text
job queued in pg-boss
→ admission checks pass
→ worker container created
→ repository checked out
→ tools execute
→ SARIF/JSON uploaded
→ findings normalized
→ worker destroyed
→ pg-boss job completed
```

---

## 8. Off-Production Weekly Deep Audit

### 8.1 Source of Scan Data

Weekly security analysis does not run against production website servers.

Inputs come from:

1. **Git repositories**
   - Full source tree.
   - Full Git history where required.
   - Dependency lockfiles.

2. **Deployment artifacts**
   - Immutable build/package artifact used for production.
   - Artifact hash and deployment ID.

3. **WordPress inventory**
   - Core version.
   - Plugin/theme inventory and versions.
   - Deployment manifest.
   - Mutation events.
   - Integrity evidence created during deployment/update workflows.

4. **Sanitized staging snapshots**
   - Used when application-runtime inspection is required.
   - Production PII and production credentials are removed before tests/scans.

5. **Infrastructure metadata**
   - OS/package inventory collected using lightweight allow-listed metadata commands or an existing monitoring/asset-inventory mechanism.
   - No full filesystem/malware scanner is launched on the live web host.


### 8.1.1 Artifact Storage Policy

The central VPS uses local NVMe primarily for:

- PostgreSQL,
- Docker/container layers,
- active repositories,
- short-lived scan workspaces,
- temporary staging data,
- short-lived caches.

Long-lived artifacts should be moved to external object storage as early as practical, including:

- SARIF/JSON scan outputs,
- Playwright screenshots,
- visual-diff bundles,
- archived logs,
- historical deployment artifacts,
- malware-analysis bundles,
- long-term audit exports,
- backup archives.

Local retained artifacts must have:

- explicit TTL,
- size quota,
- cleanup policy,
- low-disk watermark enforcement.

Object storage is treated as the preferred production retention tier, not merely a future optimization.

### 8.2 Weekly Serialized Pipeline

The weekly audit combines code, dependency, application-vulnerability, OS-hardening, and external TLS/network posture checks while keeping heavy scanners off the live production servers.

```text
Stage 1: Repository & history analysis
  - full Semgrep repository scan
  - Gitleaks full-history scan
  - dependency/SCA analysis
  - stack-specific static checks

        ↓

Stage 2: WordPress/CMS vulnerability correlation
  - WPScan vulnerability database checks for WordPress core/plugin/theme versions
  - CMS package/advisory correlation for Payload, Directus, and Strapi
  - version/CVE/exploitability mapping

        ↓

Stage 3: Host hardening evidence
  - Lynis benchmark scan against a replicated/sanitized system image, hardened reference image, or maintenance clone
  - production host receives only lightweight inventory collection where required
  - no full Lynis execution on a live customer-serving host during normal operations

        ↓

Stage 4: External TLS/network posture
  - testssl.sh or equivalent from the central worker against public production endpoints
  - certificate expiry/chain checks
  - supported protocol/cipher checks
  - HSTS/security-header validation
  - externally reachable port/service validation using safe, rate-limited checks

        ↓

Stage 5: Ephemeral staging security/functional validation
  - Playwright
  - ZAP against staging only
  - functional tests

        ↓

Stage 6: Artifact/file inspection when required
  - ClamAV or equivalent against copied artifacts/snapshots
  - never against live production filesystem

        ↓

Stage 7: Findings normalization / AI-assisted triage
```

### 8.2.1 WordPress Known-Vulnerability Intelligence

For WordPress projects, **WPScan** (or an equivalent vulnerability-intelligence source with compatible coverage) is mandatory for weekly deep audits and update risk evaluation.

The platform correlates:

- WordPress core version,
- plugin versions,
- theme versions,
- known CVEs/advisories,
- fix availability,
- vulnerability severity,
- exploit/public-advisory context where available.

WPScan is executed on the central management VPS or an ephemeral worker using centrally collected version inventory. It is not run as a heavy scanner on the live production server.

A finding is created when an installed component version is known vulnerable even if static source analysis reports no issue.

### 8.2.2 OS Hardening Benchmarking

**Lynis** is included as the host-hardening benchmark tool.

Because production servers must not carry deep-scan load, Lynis is used through one of the following approved approaches:

1. scan a current infrastructure image/clone that matches production configuration;
2. scan a temporary maintenance clone/snapshot;
3. run during an explicitly approved maintenance window where operational impact has been assessed.

Routine live-site operation does not permit unrestricted deep host scanning.

The platform separately collects lightweight production metadata required to detect drift between the assessed image and the live host.

### 8.2.3 TLS & External Network Posture

Public production endpoints are assessed externally from the central management VPS or ephemeral worker.

Checks include:

- TLS protocol versions,
- weak/deprecated ciphers,
- certificate expiry,
- certificate-chain errors,
- hostname/SAN mismatch,
- HSTS,
- HTTP security headers,
- unexpected externally exposed ports/services,
- basic redirect/TLS configuration errors.

`testssl.sh` or an equivalent lightweight TLS scanner may be used.

External checks must be:

- rate limited,
- non-destructive,
- scheduled away from known traffic peaks where practical,
- bounded by timeout,
- prohibited from exploit/payload activity against production.


### 8.3 Weekly Audit Performance Target

- Weekly audit should complete within **24 hours** for the supported initial fleet.
- Individual stages may queue.
- Production website performance always takes precedence over scan completion speed.
- If the fleet grows beyond the defined operating envelope, additional ephemeral compute or a dedicated worker host becomes the preferred scaling path.

### 8.4 Developer-Triggered AI Remediation

AI remediation is **human-triggered and finding-scoped**. The platform does not autonomously patch production or silently generate mergeable fixes for every finding.

From the external Task Portal (via private API) or an authorized Telegram action, a developer may request **Generate Synthetic Patch** for a specific finding.

Flow:

1. Developer selects a finding.
2. Backend gathers the minimum required code context, scanner evidence, stack metadata, and project policy.
3. A scoped AI remediation job is queued in pg-boss.
4. The AI provider generates a proposed patch plus explanation and test guidance.
5. The patch is written to an isolated working branch/worktree.
6. Normal lint, unit, security, and project-specific checks run.
7. The developer reviews the diff.
8. Only after explicit human approval may a standard Pull Request be created.

AI-generated changes never bypass normal PR/security gates and never deploy directly to production.

### 8.5 AI Provider Abstraction

The remediation agent uses a provider abstraction so the platform can integrate with multiple LLM APIs without coupling the product to one vendor. Supported provider classes include:

- OpenAI APIs,
- Anthropic Claude APIs,
- Google Gemini APIs.

Provider selection is policy/configuration driven. Secrets for provider APIs are server-side only and must never be exposed to browser bundles or Telegram callback payloads.

The provider interface should support:

- structured prompt/input packaging,
- token/cost limits,
- model allow-lists,
- timeout/retry policy,
- redaction of unrelated secrets,
- audit logging of provider/model used,
- retention controls for code/context sent externally.

---

## 9. Remote Production Operations Security

### 9.1 No Unrestricted Docker Group Access

The remote `deploy` account must **not** receive general Docker daemon access.

Being in the Docker group is treated as root-equivalent and is not an acceptable production boundary.

### 9.2 Restricted Command Wrapper

The central controller uses:

- Ed25519 SSH keys or equivalent short-lived machine credentials.
- Source-IP firewall allow-listing.
- Dedicated restricted service account.
- Explicit `sudoers` allow-list for a server-side wrapper.
- No interactive root shell.
- No arbitrary `docker run`, `docker exec`, `docker cp`, or volume mounting.

Example high-level operations:

```text
site-control inventory <site>
site-control deploy <site> <artifact-id>
site-control update-plugin <site> <plugin> <version>
site-control rollback <site> <rollback-id>
site-control health <site>
```

The wrapper validates:

- project/site mapping,
- command,
- arguments,
- approved artifact/version,
- authorization context,
- request ID.

Every command emits an audit event.

---

## 10. WordPress Mutation Observability

A signed MU-plugin on each managed WordPress site sends asynchronous HTTPS events to the central API for:

- administrator creation/deletion,
- role changes,
- plugin activation/deactivation,
- plugin installation/deletion,
- manual plugin updates,
- core updates,
- JIT session creation/revocation.

Each event includes:

- WordPress actor ID/username,
- target entity,
- action,
- timestamp,
- actor IP,
- request/correlation ID where available,
- JIT grant/session ID where applicable,
- status.

The platform calls this **actor attribution**, not guaranteed non-repudiation.

---

## 11. Secure JIT Access

### 11.1 Principle

Developers receive temporary access, not reusable shared administrator credentials.

### 11.2 One-Time Redemption

1. Developer requests access via the external Task Portal (private API) or Telegram.
2. Backend evaluates project membership and policy.
3. Approval is obtained when required.
4. Backend generates a high-entropy opaque redemption secret.
5. Only a hash is stored server-side.
6. Redemption is performed through a POST request.
7. Backend atomically validates and consumes the code.
8. A short-lived WordPress access session/user is created.
9. Grant is revoked automatically on expiry or task completion.

The redemption record is bound to:

- developer,
- project,
- environment,
- permission scope,
- grant ID,
- expiry,
- approval record.

No reusable WordPress password is sent through Telegram.

---



## 12. Threat Model

The platform must be implemented against explicit attacker scenarios rather than controls in isolation.

### 12.1 Compromised Developer Workstation

Assume an attacker may obtain:

- developer browser/session state,
- Git credentials,
- local repository access,
- Telegram account/session,
- project knowledge.

Required containment:

- project-scoped RBAC,
- fresh authorization for privileged actions,
- JIT expiry/revocation,
- no reusable production passwords,
- MFA for privileged approvals,
- anomaly/audit visibility,
- inability to convert repository access alone into production administrative access.

### 12.2 Compromised Git Provider Account

A compromised GitHub/GitLab-equivalent account must not automatically grant production authority.

Controls:

- branch protection,
- required reviews where configured,
- CI security gates,
- deployment authorization independent of Git push permission,
- environment-scoped permissions,
- signed/verified webhook handling,
- no secret material in repository configuration,
- audit correlation between Git event and production action.

### 12.3 Compromised Production WordPress/CMS

Treat every managed production application as potentially hostile to the central control plane.

A compromised site may send malformed or malicious mutation events.

Controls:

- authenticated/signed inbound events,
- replay protection,
- strict schema validation,
- bounded payload sizes,
- no command execution based directly on webhook contents,
- project/site identity verification,
- rate limiting,
- asynchronous processing,
- no production-originated request may directly invoke arbitrary central worker execution.

A compromised production site must not be able to pivot into central-platform RCE.

### 12.4 Compromised Management VPS

The management host is assumed capable of becoming compromised despite hardening.

The design must support rapid revocation of its trust relationship with production systems.

Required emergency actions:

1. revoke management-host SSH keys from all production hosts;
2. firewall-block management-host source IPs where required;
3. revoke/rotate machine credentials and integration tokens;
4. revoke active JIT sessions;
5. disable production deployment/update commands;
6. revoke/rotate Git and external API integrations;
7. restore control-plane PostgreSQL from a known-good recovery point;
8. rebuild the management host from a trusted image;
9. re-establish trust using newly generated credentials;
10. review immutable/off-host audit exports before resuming privileged automation.

### 12.5 Malicious or Abusive Authorized User

A legitimate user may intentionally misuse:

- JIT access,
- deployment controls,
- Telegram actions,
- AI remediation,
- role assignment,
- security-policy exceptions.

Controls:

- least privilege,
- project/environment scope,
- default-deny RBAC,
- separation of duties,
- no self-approval for critical actions,
- short-lived privileged grants,
- immutable audit export,
- manager/security-admin review paths.

### 12.6 Compromised Scanner / Malicious Repository

Repository content may attempt:

- shell escape,
- credential theft,
- network pivoting,
- filesystem abuse,
- resource exhaustion,
- malicious package lifecycle execution.

Controls are defined by the scanner-worker isolation boundary in Section 6.

### 12.7 Compromised AI Provider or Prompt Context Leakage

AI remediation must assume external LLM providers are outside the trusted platform boundary.

Controls:

- explicit user-trigger only,
- secret redaction before submission,
- scoped code context,
- no production credentials in prompts,
- provider/model audit log,
- enterprise/no-retention configuration where available,
- configurable provider allow-list,
- cost/token limits,
- no automatic production deployment.

## 13. Authorization Model & RBAC Hierarchy

The platform uses explicit project-scoped RBAC. `role_bindings` is not merely a storage table; it is the enforcement model used by API actions, Telegram callbacks, JIT access, deployment approvals, scan triggers, update approvals, and break-glass workflows.

### 13.1 Role Hierarchy

| Role | Scope | Core Permissions |
|---|---|---|
| **Manager** | Organization / multi-project | View all projects; assign/reassign work; approve production releases; approve/reject break-glass requests; revoke JIT sessions; manage project role bindings; view/export security and audit reports. |
| **Team Lead** | Assigned projects | Assign remediation tasks; approve standard staging-to-production promotions; approve/request JIT access; trigger scans; review findings; approve routine update units; view project audit data. |
| **Project Coordinator** | Assigned projects | View project status; create/assign non-privileged tasks; manage due dates; send reminders; view non-sensitive deployment/update status; export operational summaries. |
| **Developer** | Assigned projects | View assigned findings/tasks; run permitted PR/rescan jobs; request JIT access; request AI synthetic patches; mark work ready for review; view own/project-scoped results as authorized. |
| **Security Administrator** | Organization / security control plane | Manage security policies, scanner rules, severity overrides, non-overridable finding classes, scanner integrations, and security-specific break-glass policy. This role does not automatically receive general application-administration privileges. |

### 13.2 Permission Model

Authorization is permission-based beneath the role hierarchy. Roles map to explicit permissions such as:

- `project.view`
- `task.create`
- `task.assign`
- `finding.review`
- `scan.trigger.standard`
- `scan.trigger.deep`
- `jit.request`
- `jit.approve`
- `jit.revoke`
- `update.approve`
- `deployment.promote`
- `deployment.breakglass.request`
- `deployment.breakglass.approve`
- `security.policy.manage`
- `audit.export`
- `role_binding.manage`

Permissions are evaluated against:

- authenticated user,
- organization,
- project,
- environment,
- requested action,
- current role binding,
- temporary approval context where applicable.

No Telegram callback, API endpoint, worker request, or remote production command is authorized solely because a user holds a globally named role.

**Default-deny rule:** if the user has no applicable active role binding for the organization/project/environment, or if no granted permission explicitly matches the requested action, authorization is denied.


### 13.3 Role Binding Rules

Each role binding contains:

- `user_id`
- `organization_id`
- optional `project_id`
- `role_id`
- `granted_by`
- `granted_at`
- optional `expires_at`
- status/revocation fields

Project-scoped bindings override broad assumptions. A user may be a Team Lead on one project and a Developer on another.

All privileged role changes are themselves audited events.

### 13.4 Separation of Duties

The following controls are mandatory:

- A user cannot approve their own critical break-glass request.
- Critical two-person approval requires two distinct authorized identities.
- Security-policy changes require Security Administrator or explicitly delegated equivalent permission.
- Routine project coordination does not imply deployment-override authority.
- JIT approval and production promotion permissions are independently assignable.
- Emergency continuity rules do not bypass non-overridable security classes.

---

## 14. Telegram Security & Operations

Telegram may:

- send alerts,
- show task status,
- initiate JIT requests,
- initiate deployment approval requests,
- deliver non-sensitive links,
- request rescans,
- acknowledge incidents.

Every privileged callback uses:

- opaque callback identifier or signed HMAC state,
- short expiry,
- replay protection,
- fresh server-side RBAC validation,
- project-membership validation,
- audit logging.

### 14.1 Break-Glass Production Overrides

Telegram can initiate a break-glass request but cannot authorize the final production action.

Normal critical override requires:

- fresh re-authentication/MFA via the external portal or API,
- written justification,
- two authorized approvers,
- action/project/environment binding,
- time-limited approval,
- immutable audit event.

Never overridable:

- confirmed secret exposure,
- confirmed malware/webshell,
- confirmed active critical exploitation,
- compromised deployment/signing identity,
- production artifact-integrity failure,
- failed staging-data-safety gate.

### 14.2 Emergency Continuity Path

If a P1 incident occurs and only one designated approver is reachable:

- P1 incident must already exist.
- Only the designated on-call senior approver may proceed.
- Fresh MFA is mandatory.
- Action must be pre-defined and reversible.
- Approval TTL ≤ 10 minutes.
- Non-overridable classes remain blocked.
- Automatic escalation is sent.
- Mandatory second-person retrospective review occurs within the defined incident-review window.

An on-call approver rota is required for production use.

---

## 15. Safe WordPress Update Engine

### 15.1 No Direct Blind Production Updates

Production is not used as the test environment.

### 15.2 Workflow

```text
available update
→ compatibility/risk check
→ create restore point
→ create sanitized ephemeral staging
→ replace production secrets
→ block outbound production integrations
→ update one plugin/dependency group
→ functional + visual + health tests
→ approval/policy decision
→ controlled production promotion
→ production health verification
→ retain rollback point
```

### 15.3 Mandatory Staging Safety Controls

Before tests run:

- PII masking/anonymization.
- Staging-scoped credentials.
- SMTP interception/mail sink.
- SMS/WhatsApp disabled or sandboxed.
- Payment providers forced to sandbox.
- CRM/webhook integrations disabled unless allow-listed.
- Analytics disabled or staging-tagged.
- Search-engine indexing blocked.
- Background jobs reviewed/disabled.
- Production callbacks blocked.

Failure of the staging safety gate stops the workflow.

### 15.4 Update Granularity

Updates occur as:

- one plugin,
- one theme,
- WordPress core,
- or an explicitly defined compatible dependency group.

The system records:

- previous version,
- target version,
- compatibility history,
- migration evidence,
- tests,
- deployment result,
- rollback point.

### 15.5 Visual Testing

There is no universal pixel mismatch threshold.

Each project/page may define:

- baseline,
- tolerance,
- dynamic-region masks,
- ignored components,
- browser/viewport,
- DOM-semantic checks.

---

## 16. Native Findings & Task Model

DefectDojo is not part of the baseline.

This platform stores scanner output natively and exposes it through the private API; the external Task Portal renders it. This platform ships no storage-owning UI of its own.

Minimum first-class entities:

- `organizations`
- `users`
- `projects`
- `project_memberships`
- `role_bindings`
- `permissions`
- `environments`
- `scan_runs`
- `scan_artifacts`
- `security_findings`
- `finding_instances`
- `tasks`
- `deployments`
- `deployment_artifacts`
- `update_batches`
- `update_units`
- `rollback_points`
- `access_grants`
- `access_sessions`
- `access_revocations`
- `break_glass_requests`
- `approval_decisions`
- `audit_events`
- `telegram_callback_state`
- `notification_outbox`
- `notification_delivery_attempts`
- `workload_jobs`
- `ai_remediation_requests`

Large scanner blobs are stored as artifacts/object-storage objects with hashes and retention metadata rather than embedded indefinitely in task rows.

---

## 17. Secrets & Database Isolation

### 17.1 Database Identities

Do not use one shared PostgreSQL superuser for application services.

Use least-privilege principals on the central PostgreSQL service such as:

- `api_app`
- `pgboss_worker`
- `migration_admin`
- `backup_agent`

Vaultwarden is an external microservice with its own isolated datastore, entirely outside this platform's PostgreSQL/PgBouncer boundary; it is reached only through private API calls.

### 17.2 PgBouncer

PgBouncer protects the **central PostgreSQL state plane** by providing:

- connection pooling,
- bounded API pools,
- a dedicated isolated pool for pg-boss background workers,
- bounded scan/finding-ingestion pools,
- database-connection backpressure.

Vaultwarden is not routed through this central PgBouncer instance because it is an external microservice with its own isolated datastore, reached only through private API calls.

PgBouncer configuration must be load-tested and tuned before production rollout.

At minimum:

- API interactive traffic receives higher priority than bulk ingestion.
- Scan/finding-ingestion workers use bounded connection pools.
- **pg-boss background workers use a dedicated isolated PgBouncer pool** with explicit connection limits so queue polling and job heartbeats cannot starve API traffic.
- Connection starvation must trigger queue backpressure instead of allowing unrestricted worker fan-out.
- Pool sizing is reviewed after load tests and after major fleet-growth milestones.

### 17.3 Secret Injection

Production secret delivery should use:

- mounted secret files,
- short-lived retrieval,
- workload-scoped credentials,
- or equivalent protected secret mechanisms.

Static secrets should not be baked into images or committed into Compose files.

---

## 18. Security / Recovery Host

The Security / Recovery Host is the dedicated secrets-isolation and backup/recovery system described in Section 4.2. It is **one host/logical recovery system, not an additional duplicate node**.

Its production CPU, RAM, and storage are selected after measured testing of:

- Vaultwarden steady-state and burst behavior,
- PostgreSQL WAL reception,
- backup creation and verification,
- retention requirements,
- restore throughput,
- recovery tooling,
- expected fleet growth.

Minimum architectural requirements:

- separate failure domain where practical,
- encrypted storage,
- independent privileged credentials,
- private authenticated connectivity,
- no CI/scanning/staging workloads,
- sufficient measured capacity to meet RPO/RTO and secrets-service objectives.

This system provides recovery capability, not active-active high availability.

### 18.1 Backup / Recovery Behavior

The system receives:

- PostgreSQL WAL/archive data,
- scheduled database backups,
- Vaultwarden backup material,
- recovery metadata/runbooks.

It must support:

- backup-integrity verification,
- backup freshness monitoring,
- documented restore,
- management-plane rebuild support,
- emergency credential rotation.

### 18.2 Capacity Review

Resize the Security / Recovery Host when measured backup growth, restore duration, WAL rate, Vaultwarden load, or retention requirements approach configured safety margins.

No CPU/RAM/storage ceiling is hard-coded in this PRD.

## 19. Deployment Topology Status

Any Compose snippets produced for this project are **illustrative deployment topology**, not production-complete infrastructure-as-code.

Production IaC must additionally define:

- image version/digest pinning,
- secret delivery,
- networks/firewalls,
- health checks,
- resource limits/weights,
- ephemeral worker templates,
- scheduler admission configuration,
- backup/WAL jobs,
- recovery-node configuration,
- monitoring/alerting,
- log/artifact retention,
- least-privilege database roles,
- SSH restricted-command configuration.

---

## 20. Initial Functional Operating Envelope

The initial release is designed and validated against a representative fleet rather than a fixed VPS ceiling.

Initial functional validation target:

- up to **25 managed websites/applications**
- up to **50 repositories**
- up to **25 internal users**

These figures define the first representative test fleet, not permanent product limits and not a promise that a predetermined VPS size will support the fleet.

Before production launch, the benchmark suite must determine the infrastructure required to support this fleet while meeting the SLOs in Section 21.

If measured demand grows, scaling may include:

- resizing the management plane,
- resizing the Security / Recovery Host,
- adding dedicated worker VPSs/pools,
- increasing object-storage capacity,
- adjusting workload concurrency.

Production website servers remain outside the heavy scanner workload pool regardless of capacity.

## 21. Service Objectives & Security Invariants

### 21.1 Operational SLOs

- API availability: **≥ 99.9% monthly**
- Secrets-service (external Vaultwarden microservice) availability target: **≥ 99.95% monthly**, owned and tested by that service; this platform only measures its own private-API call success rate against it
- Standard PR gates: **95% within 5 minutes**
- JIT expiry: **95% revoked within 2 minutes; 99.9% within 5 minutes**
- Privileged audit events: **99% ingested within 60 seconds**
- Weekly audit: **95% completed within 24 hours**
- Data RPO: **≤ 15 minutes**
- Full control-plane RTO: **≤ 2 hours**
- Quarterly restore drill: **successful completion required**

### 21.2 Security Invariants

- No heavy/deep security scanner or browser-based security test runs on production live-site VPSs; production-side collection is lightweight, bounded, asynchronous, and resource-limited.
- No Jenkins host Docker socket.
- No unrestricted Docker-group remote deployment account.
- No direct Telegram final authorization for critical production override.
- No reusable developer WordPress admin password sharing.
- No query-string bearer token for JIT redemption.
- No unsanitized production database clone used as active staging.
- No production payment/SMTP/CRM credentials in staging.
- No blind multi-plugin `update --all` workflow.
- Every privileged production action must generate an audit event.

---

## 22. Implementation Roadmap

The product is delivered in maturity levels rather than attempting the full architecture in V1.

### Level 1 — Security Control Plane

**Target:** establish the trusted foundation and begin delivering security value quickly.

Includes:

- API (headless; external Task Portal integrates via private API).
- PostgreSQL + pg-boss.
- PgBouncer isolation.
- Project inventory and stack detection.
- RBAC and audit.
- Git integration.
- Semgrep.
- Gitleaks.
- SCA/dependency checks.
- restricted production metadata/deployment interface.
- Tier-0 management-host hardening.
- scanner-worker isolation baseline.
- provision the single Security / Recovery Host defined in Sections 4.2 and 18, including Vaultwarden separation, PostgreSQL backup/WAL reception, and restore verification.

**Indicative timeline:** Weeks 1–8.

### Level 2 — WordPress/CMS Security & Operations

Includes:

- WordPress JIT access.
- MU-plugin mutation events.
- WPScan vulnerability intelligence.
- CMS advisory correlation.
- safe sequential updates.
- sanitized ephemeral staging.
- Playwright validation.
- rollback points.
- TLS/certificate/header/network posture checks.

**Indicative timeline:** Weeks 9–16.

### Level 3 — Platform Hardening & Advanced Security

Includes:

- formal threat-model validation exercises.
- Lynis clone/image hardening assessment.
- ZAP against staging.
- malware/artifact inspection.
- advanced visual testing.
- management-plane compromise drills.
- expanded credential-rotation automation.
- risk scoring/prioritization.

**Indicative timeline:** Weeks 17–22.

### Level 4 — Capacity Validation & Production Sizing

This level occurs after the representative baseline platform is built. Its purpose is to determine the production ceiling from evidence rather than constrain implementation around a guessed server size.

Includes:

- Section 5 benchmark suite.
- control-plane load testing.
- scanner and deep-audit resource profiling.
- staging and Playwright resource profiling.
- backup/WAL/restore profiling.
- approved concurrency testing.
- central management-plane sizing decision.
- Security / Recovery Host sizing decision.
- worker topology and worker-capacity decision.
- initial workload-class concurrency ceilings.
- storage/object-storage capacity decision.
- documented operating reserve/headroom.
- final production capacity profile.

There is intentionally **no pre-build CPU/RAM target** for this level.

### Level 5 — AI Productivity

AI is intentionally deferred until the security/control foundation and initial production capacity profile are stable.

Includes:

- developer-triggered synthetic patch generation.
- AI-assisted triage.
- provider abstraction for OpenAI, Anthropic Claude, Google Gemini or equivalent approved providers.
- cost/token governance.
- model/provider auditing.
- optional prioritization assistance.

AI remains human-in-the-loop and cannot deploy directly to production.

**Indicative timeline:** post-baseline / after Level 4 acceptance.


## 23. Acceptance Criteria

The platform is ready for production baseline when:

1. Representative benchmark/load/security tests have been completed and a production capacity decision is documented.
2. No deep scanner is installed or executed on live production website VPSs.
3. Critical interactive API/PostgreSQL functions remain within accepted latency/error thresholds during the approved concurrent workload profile.
4. Configured worker concurrency and admission policies prevent resource exhaustion and starvation.
5. Weekly deep audits complete using central/ephemeral worker capacity only.
6. WordPress updates are validated in sanitized staging before production promotion.
7. Production remote access is restricted to allow-listed operations.
8. JIT credentials are one-time, hashed at rest, POST-redeemed, and automatically revoked.
9. Telegram privileged callbacks are replay-protected and re-authorized server-side.
10. Break-glass production override requires the defined authorization path.
11. PostgreSQL recovery succeeds from the Security / Recovery Host. Vaultwarden recovery is owned by the external Vaultwarden microservice and is out of scope for this platform's acceptance criteria.
12. Quarterly recovery and access-control drills are documented and repeatable.
13. Ephemeral staging cannot start without configured capacity, storage, database-health, and workload-admission checks.
14. Playwright/browser concurrency is configured from benchmark evidence and every browser worker is terminated automatically on timeout.
15. Retained scan artifacts and screenshots are pushed to object storage according to TTL/quota policy.
16. Stalled workers are detected by heartbeat/timeout and pg-boss capacity is reclaimed automatically.
17. PgBouncer load tests demonstrate API availability during approved scan-ingestion bursts; Vaultwarden, as an external microservice, is validated separately by its own owning team.
18. Backup/WAL freshness monitoring remains within the defined RPO.
19. RBAC enforcement is verified for Manager, Team Lead, Project Coordinator, Developer, and Security Administrator scopes.
20. No user can self-approve a critical break-glass action.
21. Weekly WordPress audits correlate installed core/plugin/theme versions against vulnerability intelligence.
22. Host-hardening assessments use Lynis on approved clones/images or maintenance workflows without imposing routine deep-scan load on live-site servers.
23. External TLS/network posture checks are non-destructive, rate-limited, bounded, and auditable.
24. WPScan, Lynis, TLS posture jobs, and AI remediation use explicit pg-boss workload classes/policies; `ai_remediation` remains disabled until Level 5.
25. Workload-class concurrency/exclusion policy is configurable and validated against the selected production topology.
26. RBAC authorization is default-deny when no active binding/permission matches the requested action.
27. The management plane is documented and operated as Tier-0 infrastructure.
28. Scanner workers have no direct Vaultwarden access, no Docker socket, no standing production credentials, and are destroyed after jobs.
29. Production-originated webhook/event payloads cannot directly invoke arbitrary central commands or worker execution.
30. A tested control-plane compromise runbook can revoke the management plane from all production hosts.
31. PostgreSQL outage behavior is fail-closed for deployments, JIT issuance, approvals, and new scanner dispatch.
32. Vaultwarden/security-host outage does not stop production websites from serving traffic.
33. AI remediation is excluded from V1 and remains user-triggered, scoped, audited, and non-deploying.
34. Production topology provisions one Security / Recovery system for Vaultwarden isolation plus backup/recovery duties unless benchmark/reliability requirements later justify further separation.
35. The selected production CPU/RAM/storage and worker topology are recorded as an operational capacity profile, not embedded as immutable product requirements.

## 24. Capacity Selection & Scaling Triggers

### 24.1 Initial Production Capacity Selection

After Levels 1–3 are sufficiently complete for representative testing:

1. execute the Section 5 benchmark suite,
2. select an initial management-plane size,
3. select a Security / Recovery Host size,
4. decide whether worker compute is co-located or separated,
5. set initial per-class concurrency,
6. document operating reserve/headroom,
7. run production-readiness tests again on the selected topology.

The selected infrastructure is an **operational profile**, not a permanent architectural ceiling.

### 24.2 Scaling Triggers

Add or resize worker/control capacity when persistent telemetry shows:

- PR queue latency outside the accepted developer-feedback objective,
- weekly/deep audit completion outside the accepted service objective,
- heavy jobs repeatedly delayed by admission control,
- sustained CPU/memory/I/O pressure,
- PostgreSQL degradation during approved workloads,
- staging/browser demand exceeding configured capacity,
- local storage growth approaching safety thresholds,
- backup/restore performance approaching RPO/RTO limits.

Preferred scaling depends on the measured bottleneck:

```text
resize management plane
        and/or
add/resize isolated worker VPSs
        and/or
resize Security / Recovery Host
        and/or
expand object storage
```

The architecture must **never** solve capacity shortages by moving deep scanning onto live production website servers.

## 25. Final Architecture Position

The platform is intentionally **not designed around a predetermined VPS ceiling**.

The build must first establish:

- functional correctness,
- security boundaries,
- worker isolation,
- deterministic workload classes,
- telemetry,
- staging behavior,
- recovery behavior,
- representative benchmark scenarios.

Only then does the team choose the production infrastructure required to meet the defined SLOs and operating envelope.

The final capacity principle is:

> **Build the platform with configurable limits and measurable workloads; benchmark it; then select the production VPS sizes, worker topology, concurrency ceilings, and storage profile from evidence.**

Efficiency and safety still come from:

- keeping always-on services appropriately lean,
- running expensive tools only when required,
- reserving responsiveness for critical interactive services,
- using admission control and hard worker limits,
- scanning repositories/artifacts/staging instead of live production servers,
- separating secrets/recovery from hostile scanner workloads,
- adding isolated worker capacity when throughput requires it.

Removing the fixed VPS-size assumption does **not** remove resource governance. It moves CPU/RAM/concurrency values from architecture constants into benchmark-derived production configuration.

Production website servers remain outside the heavy scanner workload pool under every capacity profile.

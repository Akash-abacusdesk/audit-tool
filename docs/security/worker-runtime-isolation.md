# Worker Runtime Isolation (S4-B)

Owner: D2 (`pam-mt3xnzu6`). Status: IMPLEMENTED — package `@platform/worker-runtime`, branch `fix/s4b-worker-runtime`. Frozen contract agreed with S4-A (jim: scheduler consumer, cancellation) and S4-C (dwight: mount names, image-declared users, profiles.json ceilings).

## Contract

```ts
runWorkerJob(spec: WorkerRunSpec): Promise<WorkerRunResult>   // resolves AFTER full teardown
cancel(runId: string): Promise<void>                          // idempotent; unknown/finished ids ok
startOrphanSweeper(opts?): { stop(): void }                   // call once at worker-service boot
loadProfile(name | profileForTool(tool)): ResourceLimits      // reads tool/scanner/profiles.json
```

- `cancel()` runs SIGTERM → `WORKER_TERM_GRACE_MS` (default 10s) → SIGKILL via native `docker stop -t`. The run's promise still resolves afterwards with `cancelled: true` / `status: 'cancelled'`.
- Watchdog: `limits.timeoutSeconds` expiry triggers the same path, flagging `timedOut: true`.
- Result resolves only post-teardown — consumers read outcome from one place, never poll docker.

## Threat → mechanism matrix (assert these in the S4-C/S4-D6 abuse battery)

| Threat | Mechanism | Enforced by |
|---|---|---|
| Fork bomb | `--pids-limit` from profiles.json (`pids_limit`) | engine flags |
| CPU/RAM exhaustion | `--cpus` / `--memory` from profiles.json | engine flags |
| Persistent filesystem tampering | rootfs `--read-only`; writable surface = `/out` bind (per-run host dir) + size-capped tmpfs scratch (`/tmp`, optional extras e.g. `/zap`) | engine flags |
| Docker socket / host escape via mounts | No socket, no host paths beyond the two declared binds; engine CLI runs host-side, workers never see it | runner wiring |
| Root execution | Pre-flight denies images whose `Config.User` is empty/root; NO `--user` override (image-declared user wins, zap native user included) | `preflightNonRoot` |
| Privilege escalation | `--cap-drop ALL` + `no-new-privileges` + `--init` (zombie reaping keeps pids budget honest) | engine flags |
| Network lateral movement / unapproved egress | Per-run network `platform-wnet-<runId>`; `offline` mode = docker `--internal` (no external route, native) | engine networking |
| Secret leakage | Env injected per-run by scheduler only (`PLATFORM_JOB_ID` always; job-scoped values never baked into images, never echoed by runtime) | runner wiring |
| Runaway duration | Watchdog → `stop -t` → SIGKILL; container+network removed unconditionally in `finally` | runner |
| `/out` disk exhaustion | du-watchdog polls `diskMb` budget, terminates run, marks failure (bind mounts have no native cap — deliberate) | runner |
| Orphans after crash/reboot | Label sweep `com.platform.worker=true` / `.net=true`, min-age guarded (`WORKER_ORPHAN_MIN_AGE_MS`, default 5m), skips live in-process runs | sweeper |

Post-MANAGER-restart semantics (for battery fixtures): the new manager's registry starts empty, so pre-restart workers are indistinguishable from orphans until min-age elapses — the sweep therefore reaps them no sooner than `WORKER_ORPHAN_MIN_AGE_MS` after their creation, giving the scheduler's restart-survival/requeue path its window; anything still running beyond that grace belongs to a dead manager and is correctly reaped.
| Cross-worker interference | Unique per-run network + container name; workers share nothing writable | runner |

## Egress tiering

- `offline` (semgrep/gitleaks/lynis): hard-deny day-one via internal networks — works identically on dev and VPS.
- `bridge` (trivy/wpscan/testssl/zap need target/vuln-DB egress): per-run bridged network with NAT.
  `// ponytail: destination allowlisting (host iptables DOCKER-USER rules on Linux) is a named follow-up BEFORE the Section-5 abuse battery asserts default-deny for target classes; on Windows dev this mode has unrestricted egress.`

## Capacity knobs (env, capacity-agnostic defaults)

`WORKER_TERM_GRACE_MS` (10000), `WORKER_SWEEPER_INTERVAL_MS` (60000), `WORKER_ORPHAN_MIN_AGE_MS` (300000), `WORKER_OUT_DU_POLL_MS` (30000), `WORKER_LOG_TAIL_LINES` (200), `WORKER_PROFILES_PATH`.

## Validation status (2026-08-26, engine 29.7.2)

- Pure self-check (`scripts/selfcheck.mjs`): arg-builder snapshot + registry parsing — PASS.
- Live battery 11/11: root-image preflight DENY (postgres:17-alpine, empty user); completed run on real scanner image `devsecops/scanner-gitleaks:v8.18.4` (user 10001) with artifact exported to host `/out`; watchdog expiry → `timedOut` inside budget+grace; `cancel(unknown)` idempotent; sweep tick clean; zero leftover containers/networks after every case.
- Observed ceiling: Windows/Docker Desktop per-container lifecycle overhead ~18s cold (Linux VPS expected single-digit seconds) — irrelevant to correctness, relevant to throughput sizing.

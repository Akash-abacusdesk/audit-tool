# S4-C Isolation Abuse Battery

Executable fixtures asserting the worker-runtime isolation contract
(`tool/docs/security/worker-runtime-isolation.md`) against the digest-pinned
scanner images (`tool/scanner/images/*`, see `tool/scanner/build-record.json`).

## Layout

- `cases/*.json` — one file per threat row. Each declares the `spec`
  (a `WorkerRunSpec` template) and the `expect` verdict.
- `run.mjs` — harness. Loads every case, executes it through
  `@platform/worker-runtime`, applies expectations, prints `PASS/FAIL` per
  assertion and a final `RESULT n/n`.

## Verdict classes (per frozen contract @ main 8f9487b)

1. **reject** — `runWorkerJob()` REJECTS (never resolves): preflight denials
   (`root-image-deny`). Asserted via error message pattern.
2. **resolve-with-status** — run resolves with `WorkerRunResult`;
   assert on `status`, `timedOut`, `cancelled`, `exitCode`, `logsTail`,
   `/out` artifacts, leftover container/network counts.

Note: watchdog expiry AND du-watchdog disk breach both surface as
`status='timedOut'` + `timedOut:true` (SIGTERM → grace → SIGKILL path).

## Running

Requires: docker engine up; built scanner images (see build-record);
built `@platform/worker-runtime` dist (resolved via package name from a
monorepo checkout, or sibling path `tool/packages/worker-runtime/dist`).

```
node tool/scanner/tests/abuse/run.mjs
```

Battery pacing knobs are set inside `run.mjs`
(`WORKER_TERM_GRACE_MS=3000`, `WORKER_OUT_DU_POLL_MS=1000`).

## Case index

| # | case | threat | expected |
|---|------|--------|----------|
| 01 | root-image-deny | root execution | reject: refusing root/undeclared user |
| 02 | nonroot-positive | positive control | resolve: uid 10001 in-container |
| 03 | fork-bomb | fork bomb | contained under pids_limit, terminated |
| 04 | disk-exhaust | /out exhaustion | du-watchdog kill: timedOut:true inside budget |
| 05 | ro-rootfs | fs tampering | writes outside /out+/tmp fail; both writable surfaces work |
| 06 | docker-sock | host escape | docker.sock absent in worker |
| 07 | env-theft | secret leakage | PLATFORM_JOB_ID only; canary never echoed |
| 08 | egress-offline | unapproved egress | wget denied on internal network |
| 09 | egress-bridge | allowlist gap | RECORD-ONLY until DOCKER-USER allowlist lands |
| 10 | timeout-watchdog | runaway duration | timedOut inside budget+grace |
| 11 | cancel | cancellation contract | cancelled:true; unknown id idempotent |
| 12 | cross-worker | interference | distinct wkr-*/wnet-* mid-flight; zero leftovers |
| 13 | orphan-sweep | crash orphans | sweepOnce tick returns clean counts |

Case 09 never fails the battery — it records observed bridge-mode egress to
document the known Windows-dev gap (see matrix ponytail note).

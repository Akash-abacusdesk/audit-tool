# Scanning Conventions — S1-D3 (D3 Security/Scanner)

Owner: D3 (`dwight-mt3xoruw`). Scope: conventions/inventory ONLY — no scanner is installed or run against real targets in Section 1.
Sources of truth: build plan `6_Developer_Task_Distribution_Capacity_Agnostic.md` L69, L84, L137–143; PRD `Unified_DevSecOps_Platform_PRD_v16_Capacity_Agnostic.md` L7 (primary design principle), L53, L432, L615, L669, L753.

**Hard rule (PRD L7):** no security scanners or deep-audit workloads on production VPSs serving live sites. All scanning runs centrally or on ephemeral isolated workers. WPScan correlates centrally from collected version inventory (PRD L94, L753). Lynis on live hosts only within approved maintenance procedures (PRD L93).

Pinned versions live in the machine-readable manifest [`scanner/tools.json`](../../scanner/tools.json) (single source; this doc never restates them). Resource ceilings live in [`scanner/profiles.json`](../../scanner/profiles.json); image packaging rules are §5.

**SCA tool choice (D3 decision, per god sign-off 2026-08-22T05:33Z):** Trivy over osv-scalibr — one binary covers language dependencies + container images + IaC with native JSON/SARIF output and a clean CRITICAL..UNKNOWN severity vocabulary that maps 1:1 onto our internal scale. osv-scalibr stays a candidate later for richer OS-package inventory extraction if Trivy's SBOM proves insufficient (Section 5+).

## 1. Tool inventory

| Tool | Category | Runs on | Output | Native severity vocabulary |
|---|---|---|---|---|
| Semgrep | SAST | ephemeral worker / central VPS | JSON + SARIF | ERROR / WARNING / INFO |
| Gitleaks | Secrets | ephemeral worker / central VPS | JSON + SARIF | (none) |
| Trivy | SCA | ephemeral worker / central VPS | JSON + SARIF | CRITICAL / HIGH / MEDIUM / LOW / UNKNOWN |
| WPScan | CMS vuln correlation | central VPS only | CLI JSON | alert / warning / info (+ advisory severity) |
| Lynis | Host hardening | central VPS / worker (approved procedures) | JSON log | warning / suggestion |
| testssl.sh | TLS posture | central VPS (external view) | JSON | CRITICAL/HIGH/MEDIUM/LOW/INFO/OK/WARN/NOT OK |
| ZAP | DAST — staging only | ephemeral worker | ZAP JSON + SARIF | HIGH / MEDIUM / LOW / INFO |

## 2. Unified scanner-result format

Every adapter emits one JSON document (JSONL for finding batches) with this envelope:

```json
{
  "schema_version": "1.0",
  "scan_id": "<uuid>",
  "project_id": "<uuid>",
  "tool": { "name": "semgrep", "version": "1.86.0", "image_digest": "sha256:…" },
  "target": {
    "kind": "repo|artifact|url|host-metadata",
    "ref": "<git sha | image digest | URL | host inventory id>",
    "branch": null
  },
  "started_at": "2026-08-22T00:00:00Z",
  "finished_at": "2026-08-22T00:05:00Z",
  "status": "completed|failed|partial",
  "error_summary": null,
  "findings": [ { … } ]
}
```

### Finding fields

| Field | Type | Notes |
|---|---|---|
| `finding_fingerprint` | string | `sha256(tool \| rule_id \| target.ref \| location.path \| normalized_location)`. Stable across runs → idempotent upsert key. |
| `rule_id` | string | Native rule/test id from the tool. |
| `title`, `description` | string | Description may be truncated to 4 KB. |
| `severity` | enum | Internal scale: `critical \| high \| medium \| low \| info` (see §3). |
| `native_severity` | string | Verbatim tool output level, kept for auditability. |
| `confidence` | enum | `certain \| firm \| tentative` (ZAP/Gitleaks confidence passes through; default `firm`). |
| `location` | object | `{ path, start_line, end_line }` or `{ url_param }` for DAST; nullable. |
| `evidence` | string? | Snippet ≤ 20 lines; **secrets must be redacted before emission** (Gitleaks evidence shows match id, not the secret). |
| `remediation` | object | `{ summary, references[] }`. |
| `cve_ids[]`, `advisory_ids[]` | array | For SCA/CMS findings. |
| `metadata` | object | Tool-specific extras (e.g. Trivy pkg name/version, ZAP plugin id). Never store raw tool output here — archive it (§4). |

## 3. Severity normalization

One internal scale everywhere: **critical > high > medium > low > info**. Mapping table (adapter-owned; changes require D3 review):

| Tool | Native → internal |
|---|---|
| Semgrep | ERROR→high, WARNING→medium, INFO→low. `critical` reserved: policy override list for verified RCE/auth-bypass rules. |
| Gitleaks | no native level → all confirmed matches **high**; allowlist paths = `false_positive` at triage, not deletion. |
| Trivy | direct map; UNKNOWN→low + `confidence: tentative`. |
| WPScan | advisory severity when present (incl. critical); else alert→high, warning→medium, info/entry→info. |
| Lynis | warning-group tests→medium, suggestion→low; hardening index stored as metric, not finding. |
| testssl.sh | NOT OK/CRITICAL→critical/high per check class, HIGH→high, MEDIUM→medium, LOW→low, WARN→low, INFO/OK→info (OK usually suppressed). |
| ZAP | direct map; Informational→info; `confidence` field carries ZAP confidence. |

Rules: normalization happens in the adapter, never downstream; `native_severity` is always preserved verbatim; a mapping change re-normalizes historical findings only via explicit backfill job.

## 4. SARIF/JSON ingestion conventions

1. **Adapter contract:** one adapter per tool converts native output → §2 envelope. Adapters are pure functions (input file → envelope); no DB access inside adapters.
2. **Raw archival first:** original SARIF/JSON is archived verbatim before parsing at `scans/{scan_id}/raw/{tool}.{sarif|json}`. Normalized output must be reproducible from the archived raw file.
3. **Transport:** adapters POST the envelope to `POST /api/v1/scans/{scan_id}/findings` in JSONL batches ≤ 1000 findings; server responds with accepted/rejected fingerprints. Failed batches retry with same scan_id — idempotency comes from `finding_fingerprint` upsert (no duplicate rows).
4. **PG alignment (per committed `docs/db-conventions.md`, S1-D1):** findings state lives in tables owned by the scanning service and prefixed accordingly (`scan_runs`, `scan_findings`) — cross-service SQL is forbidden, consumers read via API. snake_case columns; `severity` as text constrained by CHECK until an enum type is agreed; `created_at/updated_at timestamptz NOT NULL DEFAULT now()`; `finding_fingerprint` UNIQUE within `scan_findings` (dedupe key); raw artifacts referenced by storage path, never stored inline in PG. Ingestion responses use the standard `{ok:true,data}|{ok:false,error}` envelope and zod contracts from `@platform/shared`; unsafe ingestion POSTs honor `Idempotency-Key` per db-conventions §3; any pg-boss normalization jobs are enqueued **after** commit (db-conventions §2).
5. **Failure semantics:** a failed scan still records an envelope row with `status: failed|partial` and `error_summary`; scanner crash must leave no orphaned worker/workspace (build plan L548).

## 5. Image packaging & runtime profiles (S4-C)

Machine-readable sources: [`scanner/tools.json`](../../scanner/tools.json) (pins + base digests), [`scanner/profiles.json`](../../scanner/profiles.json) (resource classes). One Dockerfile per tool under `scanner/images/<tool>/Dockerfile`.

### 5.1 Packaging rules

1. **Digest authority:** every image starts `FROM <ref>@sha256:<manifest-list digest>`. Tags drift; digests don't. The pinned digest is mirrored into `tools.json` (`digest_sha256`). Rebuilds never retag in place — a rebuild produces a new tag and a PR bump.
2. **Wrapper pattern (default):** upstream image re-pinned by digest, uniform labels, non-root, standard entrypoint. Used where a trustworthy upstream image exists at our pinned version.
3. **Source-build pattern (wpscan, lynis):** when no upstream image exists at the pinned version (verified 2026-08-26: hub `wpscanteam/wpscan` stops at 3.8.18; no `cisofy/lynis` on hub or ghcr), we build from a digest-pinned minimal base with the exact tool version installed at build time (gem version pin / checksummed release tarball). phpcs-wpcs will follow this pattern in Section 5.
4. **Non-root everywhere:** numeric `USER 10001` (zap keeps its image-native `zap` user for filesystem ownership). No docker socket, no host mounts beyond the two below, caps dropped by the worker runtime (S4-B contract).
5. **Container interface (worker contract, agreed with S4-B):** input mounted read-only at `/workspace`; findings/raw output written to `/out` (read-write mount); process working directory is a writable scratch dir (`/tmp`, `/zap` for ZAP). Nothing else is assumed writable.
6. **Verification record (2026-08-26):** all pins were checked against live registries. Corrections made vs the S1 draft: semgrep's real location is hub `returntocorp/semgrep` (ghcr path absent); gitleaks tags are `v`-prefixed; testssl.sh has no `3.2rc3` tag (rolling `3.2` used, digest is the immutability authority); wpscan and lynis moved to source-build per rule 3.

### 5.2 Egress expectations (default-deny floor, allowlist exceptions)

Worker egress is default-deny (abuse battery asserts this). Scanners legitimately need outbound access to targets and vulnerability databases; these are the ONLY sanctioned destinations, enforced by the runtime network policy per scan class:

| Tool | Sanctioned egress |
|---|---|
| semgrep | none (offline rulesets); optional rules fetch via platform proxy |
| gitleaks | none |
| trivy | vuln DB mirror (ghcr.io/aquasecurity) + target image registries for image scans |
| wpscan | target URL + wpvulndb API (token via injected env, never baked) |
| lynis | none |
| testssl.sh | target endpoint only |
| zap | staging target only |

Trivy DB freshness vs reproducibility: reproducibility scope is the scanner binary + pinned base; the vuln DB refreshes per run through the allowlisted mirror and is archived alongside raw output (§4.2).

### 5.3 Resource profiles

`profiles.json` defines `small` / `medium` / `large` ceilings (cpu, memory, pids, disk, timeout) and maps each tool. PIDs limit is the fork-bomb ceiling; timeouts drive SIGTERM→SIGKILL (grace owned by S4-B). Scheduler admission (S4-A) may pick a smaller profile within these ceilings.

### 5.4 Validation status

- **Startup validation (2026-08-26): PASS 8/8.** All seven scanner images plus the battery probe image run under hardened flags (`docker run --read-only --tmpfs /tmp --network none`): version banner prints, exit 0. Defects found and fixed during validation: wpscan missing runtime `libcurl4` after dev-purge; lynis required install-dir CWD + RO-safe log paths (wrapper redirects log/report to tmpfs); zap required writable home on scratch (`-dir /tmp/zap-home` via entrypoint wrapper, needs >= ~1 GB scratch for home init; offline-mode hostname-resolution warnings are caught/non-fatal). Derived image IDs: `scanner/build-record.json`.
- **Abuse battery: EXECUTED 2026-08-26 — 40/40 PASS.** Joint run with S4-B: full matrix through `@platform/worker-runtime` (worktree off main 8f9487b, fixtures @ scanner-packaging 6b67f94), teardown-honesty rows green. The battery caught five real runtime defects (async loadProfile Promise-spread; docker ps label/createdAt parsing; cancel() startup race; du-breach misclassified 'failed' instead of timedOut:true; spec.env verbatim forwarding violating the iface-lock) — all fixed on pam's fix/worker-profiles-sync branch, merge request to god. Known documented ceilings: bridge-mode egress allowlist enforcement (Linux DOCKER-USER) pending — record-only row observed EGRESS-OK on Windows dev as expected; registry push of derived images pending floor registry decision (`scanner/build-record.json` holds local config IDs paired with profiles manifest_version 1).

# WP Vulnerability & Update Intelligence — `wp-vuln-intel` (S10-D3)

Correlates a WordPress version inventory (produced by S10-D4) against
WPScan / advisory intelligence and emits normalized `findingInput[]` records
with CVE ids, fixed-version recommendations, and update-risk data.

## Inventory contract (consumed from S10-D4)

`kevin`'s inventory is read from `wp-inventory.json` in the scan workspace:

```json
{
  "core":   { "version": "6.3.1" },
  "plugins": [ { "slug": "elementor", "version": "3.5.0", "active": true } ],
  "themes":  [ { "slug": "avada", "version": "7.5.0", "active": true } ]
}
```

- `slug` must match the advisory dataset slug (`core`, plugin slug, theme slug).
- `active` is optional; defaults to `true` and drives update-risk priority.

## Correlation engine

- `correlateInventory(inventory, advisories, targetRef)` — pure, testable core.
- A version `v` is vulnerable when **any** advisory range matches:
  `(introduced == null || v >= introduced) && (fixed == null || v < fixed)`.
  `fixed` is the first non-vulnerable version (exclusive upper bound).
- A non-vulnerable installed version yields **no** finding for that component.

## Advisory source

The bundled `WP_ADVISORIES` fixture mirrors the WPScan / WPVulnDB record shape
(slug, type, severity, `cve_ids`, `advisory_ids`, `vulnerable_ranges`,
`fixed_in`, `update_risk`). It is a curated local dataset so correlation runs in
CI / sandbox with no network or keys.

**Live API integration point:** when `WPSCAN_API_TOKEN` is configured, a client
that fetches advisories per slug supersedes `WP_ADVISORIES` via `getAdvisories()`.
No network call is made in the local path (YAGNI until the tokened runner exists).

## Output

Each finding reuses the shared S5-D1 `FindingInput` schema (no migration needed):

- `rule_id`: `wp-vuln-intel.<core|plugin|theme>.<slug>.<cve-or-advisory>`
- `cve_ids` / `advisory_ids`: populated from the advisory record
- `remediation.summary`: `Update <slug> to <fixed_in> or later` (or remove if none)
- `metadata`: `{ componentType, slug, installedVersion, fixedVersion, active,
  updateRisk, majorJump, wpVulnDb: true }`

## Validation (build-plan L848-851)

- Known-vulnerable inventory → expected findings created.
- Fixed-version shown when available.
- Non-vulnerable version → no false-positive finding.
- Full battery: `tests/unit/scanner/wpVulnIntel.test.ts`.

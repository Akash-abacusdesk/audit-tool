/**
 * S5-D5 findings contract — the canonical normalized-finding shape.
 *
 * Consumed by the portal findings UI (D5) and produced by the D1 finding
 * lifecycle APIs backed by the D3 normalized findings store. Kept in
 * `@platform/shared` so API and portal agree on the wire shape, mirroring
 * how `AuditEventDto` lives here for the audit UI.
 *
 * RBAC: portal gating uses `finding.read` (list) and `finding.update`
 * (assign / status / remediation changes) — both already declared in
 * `rbac.ts`. The lifecycle `scan.ingest` permission gates the pipeline that
 * writes these rows.
 */
export {};

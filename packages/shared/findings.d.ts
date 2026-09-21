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
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** Triage lifecycle — who is acting on the finding. */
export type FindingStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed' | 'suppressed';
/** Remediation progress — distinct from triage status. */
export type RemediationStatus = 'not_started' | 'in_progress' | 'fixed' | 'wont_fix' | 'false_positive';
/** Scanner that produced the finding; open union so new tools can be added. */
export type ScannerSource = 'semgrep' | 'gitleaks' | 'trivy' | 'testssl' | 'lynis' | 'wpscan' | 'zap' | 'manual' | (string & {});
export interface FindingEvidence {
    snippet?: string;
    filePath?: string;
    line?: number;
    column?: number;
    ruleId?: string;
    raw?: Record<string, unknown>;
}
export interface FindingDto {
    id: string;
    title: string;
    description?: string | null;
    severity: FindingSeverity;
    status: FindingStatus;
    remediationStatus: RemediationStatus;
    scannerSource: ScannerSource;
    scannerRuleId?: string | null;
    cwe?: string | null;
    references?: string[] | null;
    projectId?: string | null;
    environmentId?: string | null;
    scanRunId?: string | null;
    /** User id the finding is assigned to, or null when unassigned. */
    assignedTo?: string | null;
    assignedTeam?: string | null;
    createdAt: string;
    updatedAt: string;
    evidence?: FindingEvidence | null;
}
export interface FindingListQuery {
    severity?: FindingSeverity;
    status?: FindingStatus;
    remediationStatus?: RemediationStatus;
    scannerSource?: string;
    search?: string;
    assignedTo?: string;
    projectId?: string;
    limit?: number;
    cursor?: string;
}
export interface FindingListResponse {
    items: FindingDto[];
    nextCursor: string | null;
}
/** PATCH body for the assignment endpoint. */
export interface AssignFindingRequest {
    assignedTo: string | null;
    assignedTeam?: string | null;
}
/** PATCH body for the status/remediation update endpoint. */
export interface UpdateFindingRequest {
    status?: FindingStatus;
    remediationStatus?: RemediationStatus;
}

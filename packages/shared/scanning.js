/**
 * Section-5 scanning plane contracts (S5-D1): normalized finding model, scan
 * run persistence shape, and the lifecycle/filter DTOs shared by the API
 * (server) and the portal (client). Conventions source of truth:
 *   - docs/scanning/SCANNING-CONVENTIONS.md §2–§4 (envelope + finding fields)
 *   - docs/db-conventions.md / docs/api-conventions.md (envelope, pagination)
 *
 * Ingestion: adapters POST the §2 envelope to
 * `POST /api/v1/scans/:scanId/findings`. `finding_fingerprint` is the stable
 * dedup key (adapter-owned, sha256 of tool|rule_id|target.ref|location).
 */
import { z } from 'zod';
// ---- Enums (shared vocabulary, adapter does the native→internal mapping) ----
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const CONFIDENCES = ['certain', 'firm', 'tentative'];
export const FINDING_STATUSES = [
    'open',
    'in_progress',
    'resolved',
    'false_positive',
    'dismissed',
];
export const REMEDIATION_STATUSES = [
    'not_started',
    'in_progress',
    'done',
    'wont_fix',
];
export const TARGET_KINDS = ['repo', 'artifact', 'url', 'host-metadata'];
// ---- Finding (single, from the §2 envelope `findings[]`) ----
export const findingInput = z.object({
    finding_fingerprint: z.string().min(1).max(128),
    rule_id: z.string().max(200).optional(),
    title: z.string().min(1).max(300),
    description: z.string().max(4096).optional(),
    severity: z.enum(SEVERITIES),
    native_severity: z.string().max(60).optional(),
    confidence: z.enum(CONFIDENCES).default('firm'),
    location: z
        .object({
        path: z.string().max(1000).optional(),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        url_param: z.string().max(500).optional(),
    })
        .nullable()
        .optional(),
    evidence: z.string().max(20000).optional(),
    remediation: z
        .object({
        summary: z.string().max(2000).optional(),
        references: z.array(z.string().max(1000)).max(50).optional(),
    })
        .optional(),
    cve_ids: z.array(z.string().max(40)).max(50).optional(),
    advisory_ids: z.array(z.string().max(80)).max(50).optional(),
    metadata: z.record(z.unknown()).optional(),
});
// ---- Scan envelope (§2) ----
const toolShape = z.object({
    name: z.string().min(1).max(60),
    version: z.string().max(60).optional(),
    image_digest: z.string().max(120).optional(),
});
const targetShape = z.object({
    kind: z.enum(TARGET_KINDS),
    ref: z.string().min(1).max(500),
    branch: z.string().max(200).nullable().optional(),
});
export const scanEnvelope = z.object({
    schema_version: z.string().max(20).optional(),
    scan_id: z.string().min(1).max(64),
    project_id: z.string().uuid(),
    environment_id: z.string().uuid().optional(),
    tool: toolShape,
    target: targetShape,
    started_at: z.string().datetime().optional(),
    finished_at: z.string().datetime().optional(),
    status: z.enum(['completed', 'failed', 'partial']),
    error_summary: z.string().max(2000).nullable().optional(),
    raw_artifact_path: z.string().max(1000).optional(),
    findings: z.array(findingInput).max(5000),
});
// ---- Query / mutation contracts ----
export const findingListQuery = z.object({
    projectId: z.string().uuid().optional(),
    orgId: z.string().uuid().optional(),
    environmentId: z.string().uuid().optional(),
    severity: z.array(z.enum(SEVERITIES)).optional(),
    status: z.array(z.enum(FINDING_STATUSES)).optional(),
    scanner: z.string().max(60).optional(),
    ruleId: z.string().max(200).optional(),
    assignedTo: z.string().uuid().optional(),
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    cursor: z.string().optional(),
});
export const findingUpdateInput = z
    .object({
    status: z.enum(FINDING_STATUSES).optional(),
    remediationStatus: z.enum(REMEDIATION_STATUSES).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
})
    .refine((v) => v.status !== undefined || v.remediationStatus !== undefined || v.assignedTo !== undefined, {
    message: 'at least one of status, remediationStatus, assignedTo is required',
});

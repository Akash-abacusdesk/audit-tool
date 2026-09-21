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
export declare const SEVERITIES: readonly ["critical", "high", "medium", "low", "info"];
export type Severity = (typeof SEVERITIES)[number];
export declare const CONFIDENCES: readonly ["certain", "firm", "tentative"];
export type Confidence = (typeof CONFIDENCES)[number];
export declare const FINDING_STATUSES: readonly ["open", "in_progress", "resolved", "false_positive", "dismissed"];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export declare const REMEDIATION_STATUSES: readonly ["not_started", "in_progress", "done", "wont_fix"];
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];
export declare const TARGET_KINDS: readonly ["repo", "artifact", "url", "host-metadata"];
export type TargetKind = (typeof TARGET_KINDS)[number];
export declare const findingInput: z.ZodObject<{
    finding_fingerprint: z.ZodString;
    rule_id: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    severity: z.ZodEnum<["critical", "high", "medium", "low", "info"]>;
    native_severity: z.ZodOptional<z.ZodString>;
    confidence: z.ZodDefault<z.ZodEnum<["certain", "firm", "tentative"]>>;
    location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        path: z.ZodOptional<z.ZodString>;
        start_line: z.ZodOptional<z.ZodNumber>;
        end_line: z.ZodOptional<z.ZodNumber>;
        url_param: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path?: string | undefined;
        start_line?: number | undefined;
        end_line?: number | undefined;
        url_param?: string | undefined;
    }, {
        path?: string | undefined;
        start_line?: number | undefined;
        end_line?: number | undefined;
        url_param?: string | undefined;
    }>>>;
    evidence: z.ZodOptional<z.ZodString>;
    remediation: z.ZodOptional<z.ZodObject<{
        summary: z.ZodOptional<z.ZodString>;
        references: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        summary?: string | undefined;
        references?: string[] | undefined;
    }, {
        summary?: string | undefined;
        references?: string[] | undefined;
    }>>;
    cve_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    advisory_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    finding_fingerprint: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    confidence: "certain" | "firm" | "tentative";
    evidence?: string | undefined;
    rule_id?: string | undefined;
    description?: string | undefined;
    native_severity?: string | undefined;
    location?: {
        path?: string | undefined;
        start_line?: number | undefined;
        end_line?: number | undefined;
        url_param?: string | undefined;
    } | null | undefined;
    remediation?: {
        summary?: string | undefined;
        references?: string[] | undefined;
    } | undefined;
    cve_ids?: string[] | undefined;
    advisory_ids?: string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    finding_fingerprint: string;
    title: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    evidence?: string | undefined;
    rule_id?: string | undefined;
    description?: string | undefined;
    native_severity?: string | undefined;
    confidence?: "certain" | "firm" | "tentative" | undefined;
    location?: {
        path?: string | undefined;
        start_line?: number | undefined;
        end_line?: number | undefined;
        url_param?: string | undefined;
    } | null | undefined;
    remediation?: {
        summary?: string | undefined;
        references?: string[] | undefined;
    } | undefined;
    cve_ids?: string[] | undefined;
    advisory_ids?: string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type FindingInput = z.infer<typeof findingInput>;
export declare const scanEnvelope: z.ZodObject<{
    schema_version: z.ZodOptional<z.ZodString>;
    scan_id: z.ZodString;
    project_id: z.ZodString;
    environment_id: z.ZodOptional<z.ZodString>;
    tool: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodString>;
        image_digest: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        version?: string | undefined;
        image_digest?: string | undefined;
    }, {
        name: string;
        version?: string | undefined;
        image_digest?: string | undefined;
    }>;
    target: z.ZodObject<{
        kind: z.ZodEnum<["repo", "artifact", "url", "host-metadata"]>;
        ref: z.ZodString;
        branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        kind: "repo" | "artifact" | "url" | "host-metadata";
        ref: string;
        branch?: string | null | undefined;
    }, {
        kind: "repo" | "artifact" | "url" | "host-metadata";
        ref: string;
        branch?: string | null | undefined;
    }>;
    started_at: z.ZodOptional<z.ZodString>;
    finished_at: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<["completed", "failed", "partial"]>;
    error_summary: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    raw_artifact_path: z.ZodOptional<z.ZodString>;
    findings: z.ZodArray<z.ZodObject<{
        finding_fingerprint: z.ZodString;
        rule_id: z.ZodOptional<z.ZodString>;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        severity: z.ZodEnum<["critical", "high", "medium", "low", "info"]>;
        native_severity: z.ZodOptional<z.ZodString>;
        confidence: z.ZodDefault<z.ZodEnum<["certain", "firm", "tentative"]>>;
        location: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            path: z.ZodOptional<z.ZodString>;
            start_line: z.ZodOptional<z.ZodNumber>;
            end_line: z.ZodOptional<z.ZodNumber>;
            url_param: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        }, {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        }>>>;
        evidence: z.ZodOptional<z.ZodString>;
        remediation: z.ZodOptional<z.ZodObject<{
            summary: z.ZodOptional<z.ZodString>;
            references: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            summary?: string | undefined;
            references?: string[] | undefined;
        }, {
            summary?: string | undefined;
            references?: string[] | undefined;
        }>>;
        cve_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        advisory_ids: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        finding_fingerprint: string;
        title: string;
        severity: "critical" | "high" | "medium" | "low" | "info";
        confidence: "certain" | "firm" | "tentative";
        evidence?: string | undefined;
        rule_id?: string | undefined;
        description?: string | undefined;
        native_severity?: string | undefined;
        location?: {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        } | null | undefined;
        remediation?: {
            summary?: string | undefined;
            references?: string[] | undefined;
        } | undefined;
        cve_ids?: string[] | undefined;
        advisory_ids?: string[] | undefined;
        metadata?: Record<string, unknown> | undefined;
    }, {
        finding_fingerprint: string;
        title: string;
        severity: "critical" | "high" | "medium" | "low" | "info";
        evidence?: string | undefined;
        rule_id?: string | undefined;
        description?: string | undefined;
        native_severity?: string | undefined;
        confidence?: "certain" | "firm" | "tentative" | undefined;
        location?: {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        } | null | undefined;
        remediation?: {
            summary?: string | undefined;
            references?: string[] | undefined;
        } | undefined;
        cve_ids?: string[] | undefined;
        advisory_ids?: string[] | undefined;
        metadata?: Record<string, unknown> | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    status: "completed" | "failed" | "partial";
    scan_id: string;
    project_id: string;
    tool: {
        name: string;
        version?: string | undefined;
        image_digest?: string | undefined;
    };
    target: {
        kind: "repo" | "artifact" | "url" | "host-metadata";
        ref: string;
        branch?: string | null | undefined;
    };
    findings: {
        finding_fingerprint: string;
        title: string;
        severity: "critical" | "high" | "medium" | "low" | "info";
        confidence: "certain" | "firm" | "tentative";
        evidence?: string | undefined;
        rule_id?: string | undefined;
        description?: string | undefined;
        native_severity?: string | undefined;
        location?: {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        } | null | undefined;
        remediation?: {
            summary?: string | undefined;
            references?: string[] | undefined;
        } | undefined;
        cve_ids?: string[] | undefined;
        advisory_ids?: string[] | undefined;
        metadata?: Record<string, unknown> | undefined;
    }[];
    schema_version?: string | undefined;
    environment_id?: string | undefined;
    started_at?: string | undefined;
    finished_at?: string | undefined;
    error_summary?: string | null | undefined;
    raw_artifact_path?: string | undefined;
}, {
    status: "completed" | "failed" | "partial";
    scan_id: string;
    project_id: string;
    tool: {
        name: string;
        version?: string | undefined;
        image_digest?: string | undefined;
    };
    target: {
        kind: "repo" | "artifact" | "url" | "host-metadata";
        ref: string;
        branch?: string | null | undefined;
    };
    findings: {
        finding_fingerprint: string;
        title: string;
        severity: "critical" | "high" | "medium" | "low" | "info";
        evidence?: string | undefined;
        rule_id?: string | undefined;
        description?: string | undefined;
        native_severity?: string | undefined;
        confidence?: "certain" | "firm" | "tentative" | undefined;
        location?: {
            path?: string | undefined;
            start_line?: number | undefined;
            end_line?: number | undefined;
            url_param?: string | undefined;
        } | null | undefined;
        remediation?: {
            summary?: string | undefined;
            references?: string[] | undefined;
        } | undefined;
        cve_ids?: string[] | undefined;
        advisory_ids?: string[] | undefined;
        metadata?: Record<string, unknown> | undefined;
    }[];
    schema_version?: string | undefined;
    environment_id?: string | undefined;
    started_at?: string | undefined;
    finished_at?: string | undefined;
    error_summary?: string | null | undefined;
    raw_artifact_path?: string | undefined;
}>;
export type ScanEnvelope = z.infer<typeof scanEnvelope>;
export interface FindingDto {
    id: string;
    scanRunId: string;
    projectId: string;
    environmentId: string | null;
    fingerprint: string;
    ruleId: string | null;
    title: string;
    description: string | null;
    severity: Severity;
    nativeSeverity: string | null;
    confidence: Confidence;
    scanner: string;
    scannerVersion: string | null;
    imageDigest: string | null;
    targetRef: string | null;
    targetBranch: string | null;
    location: unknown;
    evidence: string | null;
    remediation: unknown;
    cveIds: string[] | null;
    advisoryIds: string[] | null;
    metadata: unknown;
    rawArtifactPath: string | null;
    status: FindingStatus;
    assignedTo: string | null;
    assignedBy: string | null;
    assignedAt: string | null;
    remediationStatus: RemediationStatus;
    resolvedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    createdAt: string;
    updatedAt: string;
}
export interface ScanRunToolDto {
    name: string;
    version: string | null;
    imageDigest: string | null;
}
export interface ScanRunTargetDto {
    kind: TargetKind | null;
    ref: string | null;
    branch: string | null;
}
export interface ScanRunDto {
    id: string;
    scanId: string;
    projectId: string;
    environmentId: string | null;
    tool: ScanRunToolDto;
    target: ScanRunTargetDto;
    startedAt: string | null;
    finishedAt: string | null;
    status: 'completed' | 'failed' | 'partial';
    errorSummary: string | null;
    rawArtifactPath: string | null;
    findingCounts: Record<Severity, number> & {
        total: number;
        open: number;
    };
    createdAt: string;
    updatedAt: string;
}
export declare const findingListQuery: z.ZodObject<{
    projectId: z.ZodOptional<z.ZodString>;
    orgId: z.ZodOptional<z.ZodString>;
    environmentId: z.ZodOptional<z.ZodString>;
    severity: z.ZodOptional<z.ZodArray<z.ZodEnum<["critical", "high", "medium", "low", "info"]>, "many">>;
    status: z.ZodOptional<z.ZodArray<z.ZodEnum<["open", "in_progress", "resolved", "false_positive", "dismissed"]>, "many">>;
    scanner: z.ZodOptional<z.ZodString>;
    ruleId: z.ZodOptional<z.ZodString>;
    assignedTo: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status?: ("open" | "in_progress" | "resolved" | "false_positive" | "dismissed")[] | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    orgId?: string | undefined;
    projectId?: string | undefined;
    environmentId?: string | undefined;
    severity?: ("critical" | "high" | "medium" | "low" | "info")[] | undefined;
    scanner?: string | undefined;
    ruleId?: string | undefined;
    assignedTo?: string | undefined;
    search?: string | undefined;
}, {
    status?: ("open" | "in_progress" | "resolved" | "false_positive" | "dismissed")[] | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    orgId?: string | undefined;
    projectId?: string | undefined;
    environmentId?: string | undefined;
    severity?: ("critical" | "high" | "medium" | "low" | "info")[] | undefined;
    scanner?: string | undefined;
    ruleId?: string | undefined;
    assignedTo?: string | undefined;
    search?: string | undefined;
}>;
export type FindingListQuery = z.infer<typeof findingListQuery>;
export declare const findingUpdateInput: z.ZodEffects<z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<["open", "in_progress", "resolved", "false_positive", "dismissed"]>>;
    remediationStatus: z.ZodOptional<z.ZodEnum<["not_started", "in_progress", "done", "wont_fix"]>>;
    assignedTo: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status?: "open" | "in_progress" | "resolved" | "false_positive" | "dismissed" | undefined;
    assignedTo?: string | null | undefined;
    remediationStatus?: "in_progress" | "not_started" | "done" | "wont_fix" | undefined;
}, {
    status?: "open" | "in_progress" | "resolved" | "false_positive" | "dismissed" | undefined;
    assignedTo?: string | null | undefined;
    remediationStatus?: "in_progress" | "not_started" | "done" | "wont_fix" | undefined;
}>, {
    status?: "open" | "in_progress" | "resolved" | "false_positive" | "dismissed" | undefined;
    assignedTo?: string | null | undefined;
    remediationStatus?: "in_progress" | "not_started" | "done" | "wont_fix" | undefined;
}, {
    status?: "open" | "in_progress" | "resolved" | "false_positive" | "dismissed" | undefined;
    assignedTo?: string | null | undefined;
    remediationStatus?: "in_progress" | "not_started" | "done" | "wont_fix" | undefined;
}>;
export type FindingUpdateInput = z.infer<typeof findingUpdateInput>;
/** Ingestion response — mirrors SCANNING-CONVENTIONS §4 "accepted/rejected fingerprints". */
export interface IngestResultDto {
    scanId: string;
    runId: string;
    accepted: number;
    rejected: number;
    rejectedFingerprints: string[];
    runStatus: 'completed' | 'failed' | 'partial';
}

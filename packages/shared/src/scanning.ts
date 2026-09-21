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

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['certain', 'firm', 'tentative'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const FINDING_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'false_positive',
  'dismissed',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const REMEDIATION_STATUSES = [
  'not_started',
  'in_progress',
  'done',
  'wont_fix',
] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export const TARGET_KINDS = ['repo', 'artifact', 'url', 'host-metadata'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

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

export type FindingInput = z.infer<typeof findingInput>;

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

export type ScanEnvelope = z.infer<typeof scanEnvelope>;

// ---- API DTOs (server → client) ----

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
  findingCounts: Record<Severity, number> & { total: number; open: number };
  createdAt: string;
  updatedAt: string;
}

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

export type FindingListQuery = z.infer<typeof findingListQuery>;

export const findingUpdateInput = z
  .object({
    status: z.enum(FINDING_STATUSES).optional(),
    remediationStatus: z.enum(REMEDIATION_STATUSES).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.remediationStatus !== undefined || v.assignedTo !== undefined, {
    message: 'at least one of status, remediationStatus, assignedTo is required',
  });

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

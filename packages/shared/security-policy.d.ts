/**
 * Stack -> security-policy mapper — S3-D3 (dwight-mt3xoruw, build plan L287).
 *
 * Consumes DetectionInput (stack-detect.ts), emits per-stack policy assignments.
 * Pure function: no DB, no I/O — persistence is D1's (build plan L279); zod
 * schemas come later at the API boundary that serves it.
 *
 * Policy sources of truth:
 * - tool/scanner/tools.json  — pinned tools, runs_on constraints ("never production")
 * - tool/cms/signatures.json — update_surface, headless relationship metadata
 * - PRD L7/L93/L94           — scanners never on production VPSs
 * - SCANNING-CONVENTIONS.md  — severity scale + ingestion the policies schedule into
 *
 * Every mapping row carries a `rationale` (dispatch requirement: document why).
 */
import { type DetectionInput, type StackId } from './stack-detect.js';
export declare const MAPPER_VERSION = "1.0.0";
/** Scan scheduling tiers; 'manual' = nothing runs without a human clicking. */
export type Cadence = 'on-push' | 'daily' | 'weekly' | 'monthly' | 'manual';
export interface ScanCadence {
    sast: Cadence;
    secrets: Cadence;
    sca: Cadence;
    /** WPScan-style CMS vulnerability correlation (central only). */
    cms_vuln: Cadence;
    tls_posture: Cadence;
    /** ZAP — staging targets only, never production. */
    dast_staging: Cadence;
}
export interface AuthSurface {
    /** CMS admin UI reachable on a deployed endpoint. */
    cms_admin_exposed: boolean;
    /** Public REST/GraphQL surface exists (API auth hardening applies). */
    api_public: boolean;
}
export interface SecurityPolicy {
    /**
     * enforce   = normal scanning posture for a known stack.
     * deny-until-manual-review = unknown stack fallback (Section 2 principle:
     * ambiguous -> manual_review_required). Nothing is scheduled; human must
     * classify the stack before any scan workload is created.
     */
    mode: 'enforce' | 'deny-until-manual-review';
    scan_cadence: ScanCadence;
    /**
     * Allowed execution surfaces per tools.json `runs_on` — never includes
     * "production website VPS" (PRD L7 hard rule).
     */
    runs_on: ReadonlyArray<'central-vps' | 'ephemeral-worker'>;
    auth_surface: AuthSurface;
    /** signatures.json update_surface; wordpress-only today. */
    update_surface?: 'safe-update-engine-only';
    /** Hardening checklist id applied by the CMS service (Section 5+). */
    cms_hardening_profile?: string;
    /** Why this policy — one entry per governing source. */
    rationale: readonly string[];
}
export interface StackPolicyAssignment {
    stack: StackId | 'unknown';
    policy: SecurityPolicy;
}
export interface CrossStackGate {
    gate: string;
    satisfied: boolean;
    detail: string;
}
export interface PolicyAssignmentResult {
    project_id: string;
    mapper_version: typeof MAPPER_VERSION;
    assignments: StackPolicyAssignment[];
    /** Headless relationship checks (empty when not headless). */
    cross_stack_gates: CrossStackGate[];
    /** True when any unknown label or unsatisfied gate forces manual review. */
    needs_manual_review: boolean;
}
/** Deny-by-default fallback for unrecognized stacks. */
export declare const DENY_BY_DEFAULT_POLICY: SecurityPolicy;
/**
 * Map detected stacks to security-policy assignments.
 * Never throws on bad input — unknown labels degrade to deny-by-default,
 * which IS the correct output for them.
 */
export declare function mapStacksToPolicies(input: DetectionInput): PolicyAssignmentResult;

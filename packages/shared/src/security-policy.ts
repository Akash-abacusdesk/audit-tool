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
import {
  type DetectionInput,
  type StackId,
  partitionStacks,
} from './stack-detect.js';

export const MAPPER_VERSION = '1.0.0';

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

const MANUAL_CADENCE: ScanCadence = {
  sast: 'manual',
  secrets: 'manual',
  sca: 'manual',
  cms_vuln: 'manual',
  tls_posture: 'manual',
  dast_staging: 'manual',
};

/** Deny-by-default fallback for unrecognized stacks. */
export const DENY_BY_DEFAULT_POLICY: SecurityPolicy = {
  mode: 'deny-until-manual-review',
  scan_cadence: MANUAL_CADENCE,
  runs_on: [],
  auth_surface: { cms_admin_exposed: true, api_public: true },
  cms_hardening_profile: 'unclassified-hardening-v1',
  rationale: [
    'Unknown stack id cannot be classified -> most restrictive posture until a human assigns a known class (Section 2: ambiguous -> manual_review_required).',
    'Auth surfaces assumed EXPOSED (worst case) so nothing is trusted by omission.',
    'No scans scheduled: scanner selection requires a known tool matrix (tools.json) which an unclassified stack cannot guarantee.',
  ],
};

/**
 * Per-stack table. One row per canonical stack; cadences are D3 defaults from
 * the sources above and may be tuned per-project later via overrides (S4).
 */
const STACK_POLICIES: Record<StackId, SecurityPolicy> = {
  nextjs: {
    mode: 'enforce',
    scan_cadence: {
      sast: 'on-push', // semgrep TS/React rulesets on every push
      secrets: 'on-push', // gitleaks repo+diff
      sca: 'daily', // trivy node_modules/lockfile CVEs move fast
      cms_vuln: 'manual', // no CMS to correlate
      tls_posture: 'monthly', // testssl.sh against managed endpoints
      dast_staging: 'weekly', // ZAP staging crawl of SSR pages/routes
    },
    runs_on: ['ephemeral-worker', 'central-vps'],
    auth_surface: { cms_admin_exposed: false, api_public: true }, // Next API routes / server actions are public-facing
    rationale: [
      'JS/TS app code: semgrep+gitleaks cheap enough to run per push.',
      'npm dependency churn: daily Trivy SCA catches new CVEs within a day.',
      'No PHP/CMS surface -> wpscan correlation pointless (manual).',
      'Public route surface -> api_public=true drives authz review gates.',
    ],
  },
  wordpress: {
    mode: 'enforce',
    scan_cadence: {
      sast: 'on-push', // semgrep + phpcs-wpcs when pinned (tools.json planned-s5)
      secrets: 'on-push', // wp-config creds are the #1 leak class
      sca: 'weekly', // PHP deps change slower than npm
      cms_vuln: 'daily', // WPScan core/plugin/theme advisory correlation — central inventory only
      tls_posture: 'monthly',
      dast_staging: 'weekly',
    },
    runs_on: ['central-vps', 'ephemeral-worker'],
    auth_surface: { cms_admin_exposed: true, api_public: true }, // wp-admin + REST API
    update_surface: 'safe-update-engine-only', // signatures.json: updates never bypass the safe-update engine
    cms_hardening_profile: 'wp-hardening-v1', // disable file editing, xml-rpc off, etc. (docs/cms/wp-deployment-patterns.md)
    rationale: [
      'PRD L94/L753: WPScan correlates centrally from version inventory — never heavy scanning on live hosts.',
      'Plugin/theme ecosystem is top breach vector -> daily advisory correlation.',
      'signatures.json pins update_surface=safe-update-engine-only; policy mirrors it so drift is detectable.',
      'wp-admin exposure is structural -> flagged, monitored via staging DAST.',
    ],
  },
  payload: {
    mode: 'enforce',
    scan_cadence: {
      sast: 'on-push',
      secrets: 'on-push',
      sca: 'daily', // node dependency churn
      cms_vuln: 'manual', // no WPScan-class correlator yet; SCA covers admin framework CVEs
      tls_posture: 'monthly',
      dast_staging: 'weekly', // admin panel + REST/GraphQL in scope
    },
    runs_on: ['ephemeral-worker', 'central-vps'],
    auth_surface: { cms_admin_exposed: true, api_public: true },
    cms_hardening_profile: 'node-cms-hardening-v1',
    rationale: [
      'Node CMS: same cadence family as nextjs plus exposed admin surface flag.',
      'Payload ships its own admin REST/GraphQL -> api_public=true.',
      'Hardening profile covers access control + file upload restrictions (docs/cms/headless-integration-patterns.md#h1--payload-cms).',
    ],
  },
  directus: {
    mode: 'enforce',
    scan_cadence: {
      sast: 'on-push',
      secrets: 'on-push',
      sca: 'daily',
      cms_vuln: 'manual',
      tls_posture: 'monthly',
      dast_staging: 'weekly',
    },
    runs_on: ['ephemeral-worker', 'central-vps'],
    auth_surface: { cms_admin_exposed: true, api_public: true },
    cms_hardening_profile: 'node-cms-hardening-v1',
    rationale: [
      'Node CMS: daily Trivy on the Directus bundle (framework CVEs land in npm distro).',
      'Admin app + public collections -> both auth-surface flags set.',
      'Hardening profile: role/permissions least-privilege review, public-role audit (headless-integration-patterns.md#h2--directus).',
    ],
  },
  strapi: {
    mode: 'enforce',
    scan_cadence: {
      sast: 'on-push',
      secrets: 'on-push',
      sca: 'daily',
      cms_vuln: 'manual',
      tls_posture: 'monthly',
      dast_staging: 'weekly',
    },
    runs_on: ['ephemeral-worker', 'central-vps'],
    auth_surface: { cms_admin_exposed: true, api_public: true },
    cms_hardening_profile: 'node-cms-hardening-v1',
    rationale: [
      'Node CMS: daily SCA; Strapi security releases ship via npm.',
      'Admin panel + content API -> both auth-surface flags set.',
      'Hardening profile: admin roles, API token scoping, upload config (headless-integration-patterns.md#h3--strapi).',
    ],
  },
};

/** Required relationship metadata for headless pairs (signatures.json). */
const HEADLESS_REQUIRED_METADATA = [
  'frontend_project_id',
  'backend_project_id',
  'api_protocol(rest|graphql)',
] as const;

/**
 * Map detected stacks to security-policy assignments.
 * Never throws on bad input — unknown labels degrade to deny-by-default,
 * which IS the correct output for them.
 */
export function mapStacksToPolicies(input: DetectionInput): PolicyAssignmentResult {
  const { known, unknown } = partitionStacks(input.stacks);

  // Dedupe labels (detectors may emit repeats); N unknown labels collapse onto
  // one 'unknown' row since they all share DENY_BY_DEFAULT_POLICY.
  const seen = new Set<StackId>();
  const uniqueKnown = known.filter((s) => !seen.has(s) && seen.add(s));
  const assignments: StackPolicyAssignment[] = [
    ...uniqueKnown.map((stack) => ({ stack, policy: STACK_POLICIES[stack] })),
    ...(unknown.length > 0
      ? [{ stack: 'unknown' as const, policy: DENY_BY_DEFAULT_POLICY }]
      : []),
  ];

  const gates: CrossStackGate[] = [];
  if (input.headless) {
    const hasFrontend = known.includes('nextjs');
    const hasBackend = ['wordpress', 'payload', 'directus', 'strapi'].some((b) =>
      known.includes(b as StackId)
    );
    gates.push({
      gate: 'headless-pair-present',
      satisfied: hasFrontend && hasBackend,
      detail: hasFrontend && hasBackend
        ? 'Frontend (nextjs) + backend CMS pair detected.'
        : `Headless flagged but pair incomplete: frontend=${hasFrontend}, backend=${hasBackend}.`,
    });
    const evidenceKeys = Object.keys(input.evidence ?? {});
    for (const meta of HEADLESS_REQUIRED_METADATA) {
      gates.push({
        gate: `relationship-metadata:${meta}`,
        satisfied: evidenceKeys.includes(meta),
        detail: evidenceKeys.includes(meta)
          ? 'Present in detection evidence.'
          : 'Missing — required by signatures.json relationships.headless.required_metadata.',
      });
    }
  }

  return {
    project_id: input.project_id,
    mapper_version: MAPPER_VERSION,
    assignments,
    cross_stack_gates: gates,
    needs_manual_review:
      unknown.length > 0 || gates.some((g) => !g.satisfied),
  };
}

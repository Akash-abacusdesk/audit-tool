/**
 * Section 3 — Git integration contracts (S3-D1).
 * Types-as-API: pam (webhook ingress), angela (UI) and oscar (abuse tests)
 * build against these shapes; change them like runtime code, not comments.
 * Persistence lives in apps/api/migrations/004_git_integration.sql (api_* prefix,
 * db-conventions §4). Authorization reuses Section-2 scopes org > project > env.
 */
import { z } from 'zod';
// ---- Git provider connections ----
export const GIT_PROVIDERS = ['github', 'gitlab', 'bitbucket'];
export const gitProvider = z.enum(GIT_PROVIDERS);
/**
 * Where each provider carries its webhook authenticity proof. Ingress (pam)
 * MUST verify before persisting or enqueueing anything:
 * - github: HMAC-SHA256 over raw body, hex, prefixed "sha256=" (x-hub-signature-256)
 * - gitlab: shared secret compared verbatim (x-gitlab-token)
 * - bitbucket: HMAC-SHA256 over raw body, hex (x-hub-signature)
 */
export const WEBHOOK_SIGNATURE_HEADERS = {
    github: 'x-hub-signature-256',
    gitlab: 'x-gitlab-token',
    bitbucket: 'x-hub-signature',
};
export const connectionStatus = z.enum(['active', 'revoked', 'error']);
export const connectionCreateInput = z.object({
    /** Owning organization (route re-checks org.manage at this scope). */
    orgId: z.string().uuid(),
    provider: gitProvider,
    /** Caller-facing label; secrets are exchanged out-of-band via the provider
     *  install flow and stored server-side only (never in payloads). */
    displayName: z.string().min(1).max(100).optional(),
});
// ---- Webhook events (ingress → persistence → queue) ----
export const webhookEventTypes = [
    'push',
    'pull_request.opened',
    'pull_request.synchronize',
    'pull_request.closed',
];
export const webhookEventType = z.enum(webhookEventTypes);
/** Internal ingestion record (connection-authenticated, not user input). */
export const webhookEventIngest = z.object({
    connectionId: z.string().uuid(),
    deliveryId: z.string().min(1).max(200),
    eventType: webhookEventType,
    verified: z.boolean(),
    payload: z.unknown(),
});
// ---- Repo links + branch/commit/PR mapping ----
export const repoLinkCreateInput = z.object({
    projectId: z.string().uuid(),
    connectionId: z.string().uuid(),
    /** Provider numeric/id key for the repository. */
    externalRepoId: z.string().min(1).max(200),
    /** "owner/name" as shown by the provider. */
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name'),
    defaultBranch: z.string().min(1).max(200).default('main'),
});
export const pullRequestState = z.enum(['open', 'merged', 'closed']);
// ---- Stack detection (consumes kevin's detector output verbatim) ----
export const STACK_KINDS = ['nextjs', 'wordpress', 'payload', 'directus', 'strapi'];
export const stackKind = z.enum(STACK_KINDS);
/**
 * Detector wire contract (kevin/S3-D2): { stacks, headless, evidence }.
 * Mirrored verbatim — persistence adds provenance columns only.
 */
export const stackDetectionResult = z.object({
    stacks: z.array(stackKind),
    headless: z.boolean(),
    evidence: z.unknown(),
});
export const stackDetectionRecordInput = stackDetectionResult.extend({
    projectId: z.string().uuid(),
    environmentId: z.string().uuid().optional(),
    /** Commit the detection ran against, when known. */
    sourceCommitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
    detectorVersion: z.string().min(1).max(50),
});
// ---- Policy assignments (dwight's mapper ↔ Section-2 RBAC scopes) ----
export const policyAssignmentCreateInput = z.object({
    /** Policy key from the Section-3 policy catalog (dwight's mapper). */
    policyId: z.string().min(1).max(100),
    orgId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    environmentId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
});

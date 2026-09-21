/**
 * Section 3 — Git integration contracts (S3-D1).
 * Types-as-API: pam (webhook ingress), angela (UI) and oscar (abuse tests)
 * build against these shapes; change them like runtime code, not comments.
 * Persistence lives in apps/api/migrations/004_git_integration.sql (api_* prefix,
 * db-conventions §4). Authorization reuses Section-2 scopes org > project > env.
 */
import { z } from 'zod';

// ---- Git provider connections ----

export const GIT_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;
export const gitProvider = z.enum(GIT_PROVIDERS);
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/**
 * Where each provider carries its webhook authenticity proof. Ingress (pam)
 * MUST verify before persisting or enqueueing anything:
 * - github: HMAC-SHA256 over raw body, hex, prefixed "sha256=" (x-hub-signature-256)
 * - gitlab: shared secret compared verbatim (x-gitlab-token)
 * - bitbucket: HMAC-SHA256 over raw body, hex (x-hub-signature)
 */
export const WEBHOOK_SIGNATURE_HEADERS: Record<GitProvider, string> = {
  github: 'x-hub-signature-256',
  gitlab: 'x-gitlab-token',
  bitbucket: 'x-hub-signature',
};

export const connectionStatus = z.enum(['active', 'revoked', 'error']);
export type ConnectionStatus = z.infer<typeof connectionStatus>;

export const connectionCreateInput = z.object({
  /** Owning organization (route re-checks org.manage at this scope). */
  orgId: z.string().uuid(),
  provider: gitProvider,
  /** Caller-facing label; secrets are exchanged out-of-band via the provider
   *  install flow and stored server-side only (never in payloads). */
  displayName: z.string().min(1).max(100).optional(),
});
export type ConnectionCreateInput = z.infer<typeof connectionCreateInput>;

export interface GitConnectionDto {
  id: string;
  orgId: string;
  provider: GitProvider;
  displayName: string | null;
  /** Provider-side account/installation reference (opaque). */
  externalAccountId: string | null;
  status: ConnectionStatus;
  createdBy: string;
  createdAt: string;
}

// ---- Webhook events (ingress → persistence → queue) ----

export const webhookEventTypes = [
  'push',
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.closed',
] as const;
export const webhookEventType = z.enum(webhookEventTypes);
export type WebhookEventType = z.infer<typeof webhookEventType>;

/** What ingress persists after signature verification (api_webhook_events row). */
export interface WebhookEventDto {
  id: string;
  connectionId: string;
  provider: GitProvider;
  /** Provider delivery GUID; unique per connection (replay dedupe). */
  deliveryId: string;
  eventType: WebhookEventType;
  verified: boolean;
  /** Raw provider payload, stored as-is for audit/replay. */
  payload: unknown;
  receivedAt: string;
  processedAt: string | null;
}

/** Internal ingestion record (connection-authenticated, not user input). */
export const webhookEventIngest = z.object({
  connectionId: z.string().uuid(),
  deliveryId: z.string().min(1).max(200),
  eventType: webhookEventType,
  verified: z.boolean(),
  payload: z.unknown(),
});
export type WebhookEventIngest = z.infer<typeof webhookEventIngest>;

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
export type RepoLinkCreateInput = z.infer<typeof repoLinkCreateInput>;

export interface RepoLinkDto {
  id: string;
  orgId: string;
  projectId: string;
  connectionId: string;
  provider: GitProvider;
  externalRepoId: string;
  fullName: string;
  defaultBranch: string;
  createdAt: string;
}

export interface GitBranchDto {
  id: string;
  repoLinkId: string;
  name: string;
  headSha: string | null;
  updatedAt: string;
}

export interface GitCommitDto {
  id: string;
  repoLinkId: string;
  sha: string;
  branch: string;
  authorEmail: string | null;
  message: string | null;
  committedAt: string;
}

export const pullRequestState = z.enum(['open', 'merged', 'closed']);
export type PullRequestState = z.infer<typeof pullRequestState>;

export interface GitPullRequestDto {
  id: string;
  repoLinkId: string;
  /** Provider PR number. */
  externalId: string;
  sourceBranch: string;
  targetBranch: string;
  state: PullRequestState;
  title: string | null;
  headSha: string | null;
  updatedAt: string;
}

/** Result of a provider snapshot sync (S3-D1B, POST /repo-links/:id/sync). */
export interface GitSyncResultDto {
  repoLinkId: string;
  syncedAt: string;
  counts: { branches: number; commits: number; pullRequests: number };
}

// ---- Stack detection (consumes kevin's detector output verbatim) ----

export const STACK_KINDS = ['nextjs', 'wordpress', 'payload', 'directus', 'strapi'] as const;
export const stackKind = z.enum(STACK_KINDS);
export type StackKind = (typeof STACK_KINDS)[number];

/**
 * Detector wire contract (kevin/S3-D2): { stacks, headless, evidence }.
 * Mirrored verbatim — persistence adds provenance columns only.
 */
export const stackDetectionResult = z.object({
  stacks: z.array(stackKind),
  headless: z.boolean(),
  evidence: z.unknown(),
});
export type StackDetectionResult = z.infer<typeof stackDetectionResult>;

export const stackDetectionRecordInput = stackDetectionResult.extend({
  projectId: z.string().uuid(),
  environmentId: z.string().uuid().optional(),
  /** Commit the detection ran against, when known. */
  sourceCommitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  detectorVersion: z.string().min(1).max(50),
});
export type StackDetectionRecordInput = z.infer<typeof stackDetectionRecordInput>;

export interface StackDetectionDto {
  id: string;
  projectId: string;
  environmentId: string | null;
  stacks: StackKind[];
  headless: boolean;
  evidence: unknown;
  sourceCommitSha: string | null;
  detectorVersion: string;
  detectedAt: string;
}

// ---- Policy assignments (dwight's mapper ↔ Section-2 RBAC scopes) ----

export const policyAssignmentCreateInput = z.object({
  /** Policy key from the Section-3 policy catalog (dwight's mapper). */
  policyId: z.string().min(1).max(100),
  orgId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
});
export type PolicyAssignmentCreateInput = z.infer<typeof policyAssignmentCreateInput>;

export interface PolicyAssignmentDto {
  id: string;
  policyId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

/**
 * Section 3 — Git integration contracts (S3-D1).
 * Types-as-API: pam (webhook ingress), angela (UI) and oscar (abuse tests)
 * build against these shapes; change them like runtime code, not comments.
 * Persistence lives in apps/api/migrations/004_git_integration.sql (api_* prefix,
 * db-conventions §4). Authorization reuses Section-2 scopes org > project > env.
 */
import { z } from 'zod';
export declare const GIT_PROVIDERS: readonly ["github", "gitlab", "bitbucket"];
export declare const gitProvider: z.ZodEnum<["github", "gitlab", "bitbucket"]>;
export type GitProvider = (typeof GIT_PROVIDERS)[number];
/**
 * Where each provider carries its webhook authenticity proof. Ingress (pam)
 * MUST verify before persisting or enqueueing anything:
 * - github: HMAC-SHA256 over raw body, hex, prefixed "sha256=" (x-hub-signature-256)
 * - gitlab: shared secret compared verbatim (x-gitlab-token)
 * - bitbucket: HMAC-SHA256 over raw body, hex (x-hub-signature)
 */
export declare const WEBHOOK_SIGNATURE_HEADERS: Record<GitProvider, string>;
export declare const connectionStatus: z.ZodEnum<["active", "revoked", "error"]>;
export type ConnectionStatus = z.infer<typeof connectionStatus>;
export declare const connectionCreateInput: z.ZodObject<{
    /** Owning organization (route re-checks org.manage at this scope). */
    orgId: z.ZodString;
    provider: z.ZodEnum<["github", "gitlab", "bitbucket"]>;
    /** Caller-facing label; secrets are exchanged out-of-band via the provider
     *  install flow and stored server-side only (never in payloads). */
    displayName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    orgId: string;
    provider: "github" | "gitlab" | "bitbucket";
    displayName?: string | undefined;
}, {
    orgId: string;
    provider: "github" | "gitlab" | "bitbucket";
    displayName?: string | undefined;
}>;
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
export declare const webhookEventTypes: readonly ["push", "pull_request.opened", "pull_request.synchronize", "pull_request.closed"];
export declare const webhookEventType: z.ZodEnum<["push", "pull_request.opened", "pull_request.synchronize", "pull_request.closed"]>;
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
export declare const webhookEventIngest: z.ZodObject<{
    connectionId: z.ZodString;
    deliveryId: z.ZodString;
    eventType: z.ZodEnum<["push", "pull_request.opened", "pull_request.synchronize", "pull_request.closed"]>;
    verified: z.ZodBoolean;
    payload: z.ZodUnknown;
}, "strip", z.ZodTypeAny, {
    connectionId: string;
    deliveryId: string;
    eventType: "push" | "pull_request.opened" | "pull_request.synchronize" | "pull_request.closed";
    verified: boolean;
    payload?: unknown;
}, {
    connectionId: string;
    deliveryId: string;
    eventType: "push" | "pull_request.opened" | "pull_request.synchronize" | "pull_request.closed";
    verified: boolean;
    payload?: unknown;
}>;
export type WebhookEventIngest = z.infer<typeof webhookEventIngest>;
export declare const repoLinkCreateInput: z.ZodObject<{
    projectId: z.ZodString;
    connectionId: z.ZodString;
    /** Provider numeric/id key for the repository. */
    externalRepoId: z.ZodString;
    /** "owner/name" as shown by the provider. */
    fullName: z.ZodString;
    defaultBranch: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    connectionId: string;
    externalRepoId: string;
    fullName: string;
    defaultBranch: string;
}, {
    projectId: string;
    connectionId: string;
    externalRepoId: string;
    fullName: string;
    defaultBranch?: string | undefined;
}>;
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
export declare const pullRequestState: z.ZodEnum<["open", "merged", "closed"]>;
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
    counts: {
        branches: number;
        commits: number;
        pullRequests: number;
    };
}
export declare const STACK_KINDS: readonly ["nextjs", "wordpress", "payload", "directus", "strapi"];
export declare const stackKind: z.ZodEnum<["nextjs", "wordpress", "payload", "directus", "strapi"]>;
export type StackKind = (typeof STACK_KINDS)[number];
/**
 * Detector wire contract (kevin/S3-D2): { stacks, headless, evidence }.
 * Mirrored verbatim — persistence adds provenance columns only.
 */
export declare const stackDetectionResult: z.ZodObject<{
    stacks: z.ZodArray<z.ZodEnum<["nextjs", "wordpress", "payload", "directus", "strapi"]>, "many">;
    headless: z.ZodBoolean;
    evidence: z.ZodUnknown;
}, "strip", z.ZodTypeAny, {
    stacks: ("payload" | "nextjs" | "wordpress" | "directus" | "strapi")[];
    headless: boolean;
    evidence?: unknown;
}, {
    stacks: ("payload" | "nextjs" | "wordpress" | "directus" | "strapi")[];
    headless: boolean;
    evidence?: unknown;
}>;
export type StackDetectionResult = z.infer<typeof stackDetectionResult>;
export declare const stackDetectionRecordInput: z.ZodObject<{
    stacks: z.ZodArray<z.ZodEnum<["nextjs", "wordpress", "payload", "directus", "strapi"]>, "many">;
    headless: z.ZodBoolean;
    evidence: z.ZodUnknown;
} & {
    projectId: z.ZodString;
    environmentId: z.ZodOptional<z.ZodString>;
    /** Commit the detection ran against, when known. */
    sourceCommitSha: z.ZodOptional<z.ZodString>;
    detectorVersion: z.ZodString;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    stacks: ("payload" | "nextjs" | "wordpress" | "directus" | "strapi")[];
    headless: boolean;
    detectorVersion: string;
    environmentId?: string | undefined;
    evidence?: unknown;
    sourceCommitSha?: string | undefined;
}, {
    projectId: string;
    stacks: ("payload" | "nextjs" | "wordpress" | "directus" | "strapi")[];
    headless: boolean;
    detectorVersion: string;
    environmentId?: string | undefined;
    evidence?: unknown;
    sourceCommitSha?: string | undefined;
}>;
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
export declare const policyAssignmentCreateInput: z.ZodObject<{
    /** Policy key from the Section-3 policy catalog (dwight's mapper). */
    policyId: z.ZodString;
    orgId: z.ZodString;
    projectId: z.ZodOptional<z.ZodString>;
    environmentId: z.ZodOptional<z.ZodString>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    orgId: string;
    policyId: string;
    enabled: boolean;
    projectId?: string | undefined;
    environmentId?: string | undefined;
}, {
    orgId: string;
    policyId: string;
    projectId?: string | undefined;
    environmentId?: string | undefined;
    enabled?: boolean | undefined;
}>;
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

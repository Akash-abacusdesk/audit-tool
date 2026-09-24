/**
 * Section-11 Safe Staging — lifecycle state machine + safety gate + job payloads.
 *
 * Ephemeral staging environments are provisioned from a sanitized production
 * snapshot, validated, then destroyed. A test run may only start once the
 * environment is `ready` AND the safety gate (PII sanitized, integrations
 * neutralized, indexing blocked) passes — refused closed otherwise.
 */
import { z } from 'zod';
import { ApiError } from './errors.js';

// ---- Lifecycle state machine ----------------------------------------------

export const STAGING_STATES = [
  'requested',
  'provisioning',
  'ready',
  'provision_failed',
  'destroying',
  'destroyed',
] as const;

export type StagingState = (typeof STAGING_STATES)[number];

export const STAGING_EVENTS = ['provision', 'provisioned', 'provision_failed', 'destroy', 'destroyed'] as const;

export type StagingEvent = (typeof STAGING_EVENTS)[number];

const STAGING_TRANSITIONS: Record<StagingState, Partial<Record<StagingEvent, StagingState>>> = {
  requested: { provision: 'provisioning' },
  provisioning: { provisioned: 'ready', provision_failed: 'provision_failed' },
  ready: { destroy: 'destroying' },
  provision_failed: {},
  destroying: { destroyed: 'destroyed' },
  destroyed: {},
};

/** Fail-closed lifecycle transition: throws FORBIDDEN on any illegal move. */
export function transitionStaging(from: StagingState, event: StagingEvent): StagingState {
  const next = STAGING_TRANSITIONS[from]?.[event];
  if (!next) {
    throw new ApiError('FORBIDDEN', `illegal staging transition: ${from} -> ${event}`);
  }
  return next;
}

// ---- Safety gate (S11 mandatory staging safety controls) ------------------

export interface StagingSafetyContext {
  /** Production PII has been sanitized/masked in the staging snapshot. */
  piiSanitized: boolean;
  /** Outbound integrations (payment, email, webhooks, third-party APIs) are neutralized. */
  integrationsNeutralized: boolean;
  /** Search-engine indexing is blocked (robots/noindex) for the staging host. */
  noindexEnabled: boolean;
}

/** Throw FORBIDDEN unless every mandatory staging safety control passes. */
export function assertStagingSafe(ctx: StagingSafetyContext): void {
  const failed: string[] = [];
  if (!ctx.piiSanitized) failed.push('pii not sanitized');
  if (!ctx.integrationsNeutralized) failed.push('integrations not neutralized');
  if (!ctx.noindexEnabled) failed.push('noindex not enabled');
  if (failed.length) {
    throw new ApiError('FORBIDDEN', `staging safety gate failed: ${failed.join(', ')}`);
  }
}

// ---- pg-boss job payloads --------------------------------------------------

export const stagingProvisionPayload = z.object({
  stagingId: z.string().uuid(),
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  ref: z.string().min(1).max(500),
});

export type StagingProvisionPayload = z.infer<typeof stagingProvisionPayload>;

export const stagingTestRunPayload = z.object({
  stagingId: z.string().uuid(),
  suite: z.enum(['smoke', 'functional', 'visual']),
});

export type StagingTestRunPayload = z.infer<typeof stagingTestRunPayload>;

export const stagingDestroyPayload = z.object({
  stagingId: z.string().uuid(),
});

export type StagingDestroyPayload = z.infer<typeof stagingDestroyPayload>;

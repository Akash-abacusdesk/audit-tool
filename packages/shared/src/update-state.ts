/**
 * Section-13 Safe WordPress Update Engine — D1 update state machine.
 *
 * One component/dependency group is updated at a time. Every update is validated
 * in sanitized staging before production promotion, and every failure path rolls
 * back. The machine is the single source of truth for allowed transitions;
 * handlers throw FORBIDDEN on any illegal move (fail-closed), and no staging
 * validation may begin until staging is ready (the S11 safety gate).
 */
import { ApiError } from './errors.js';

export const UPDATE_STATES = [
  'discovered',
  'restore_point',
  'staging_validation',
  'functional_validation',
  'visual_validation',
  'approved',
  'promoting',
  'promoted',
  'rollback',
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_EVENTS = [
  'snapshot',
  'stage',
  'staging_passed',
  'staging_failed',
  'functional_passed',
  'functional_failed',
  'visual_passed',
  'visual_failed',
  'approve',
  'reject',
  'promote',
  'promote_failed',
  'recovered',
] as const;

export type UpdateEvent = (typeof UPDATE_EVENTS)[number];

/** Allowed transitions: from ──event──▶ to. */
const TRANSITIONS: Record<UpdateState, Partial<Record<UpdateEvent, UpdateState>>> = {
  discovered: { snapshot: 'restore_point' },
  restore_point: { stage: 'staging_validation' },
  staging_validation: { staging_passed: 'functional_validation', staging_failed: 'rollback' },
  functional_validation: { functional_passed: 'visual_validation', functional_failed: 'rollback' },
  visual_validation: { visual_passed: 'approved', visual_failed: 'rollback' },
  approved: { approve: 'promoting', reject: 'rollback' },
  promoting: { promote: 'promoted', promote_failed: 'rollback' },
  promoted: {},
  rollback: { recovered: 'discovered' },
};

export interface TransitionContext {
  /** Staging must be ready before staging_validation may begin (S11 gate). */
  stagingReady?: boolean;
}

export function canTransitionUpdate(
  from: UpdateState,
  event: UpdateEvent,
  ctx: TransitionContext = {}
): boolean {
  if (event === 'stage' && from === 'restore_point' && ctx.stagingReady === false) return false;
  return TRANSITIONS[from]?.[event] !== undefined;
}

/** Apply an event, throwing FORBIDDEN on any illegal transition (fail-closed). */
export function transitionUpdate(
  from: UpdateState,
  event: UpdateEvent,
  ctx: TransitionContext = {}
): UpdateState {
  if (event === 'stage' && from === 'restore_point' && ctx.stagingReady === false) {
    throw new ApiError(
      'FORBIDDEN',
      'cannot begin staging validation before staging is ready (S11 safety gate)'
    );
  }
  const next = TRANSITIONS[from]?.[event];
  if (!next) {
    throw new ApiError('FORBIDDEN', `illegal update transition: ${from} --${event}--> ?`);
  }
  return next;
}

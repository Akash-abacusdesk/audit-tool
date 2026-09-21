/**
 * Stack-detection contract — S3-D3 (dwight-mt3xoruw).
 *
 * RECONCILED (S3-TYPES, kevin-mt3xpopc): the stack vocabulary (STACK_IDS /
 * StackId) is canonical in @platform/stack-detect and re-exported here —
 * dwight's imports from this module are unchanged. DetectionInput stays
 * defined HERE on purpose: it is the mapper/persistence-side shape (carries
 * project_id, accepts unknown labels so the mapper can fail closed) and is
 * deliberately looser than the engine's StackDetectResult producer output.
 *
 * Producer: stack detection emits one DetectionInput per project.
 * Consumer: security-policy mapper (@platform/shared security-policy.ts),
 *           persistence lands via D1's Git-integration tables (build plan L279).
 * Stack ids map 1:1 to tool/cms/signatures.json v1.0.0.
 */
import { STACK_IDS, type StackId } from '@platform/stack-detect';

export { STACK_IDS };
export type { StackId };

/**
 * PRD L554-558: headless is a relationship label, not a stack — a headless
 * project carries >=2 stack labels (frontend + backend). It is NOT a member of
 * `stacks`; it rides the boolean below.
 */
export interface DetectionInput {
  /** Owning project (uuid). */
  project_id: string;
  /**
   * Raw detected stack labels. Typed as string[] (not StackId[]) on purpose:
   * detectors can emit unrecognized ids and the mapper must classify them as
   * 'unknown' -> deny-by-default instead of trusting the wire.
   */
  stacks: readonly string[];
  /** True when a Next.js frontend consumes an external CMS/API backend. */
  headless: boolean;
  /** Matched detection signals keyed by signal name (files/manifests/endpoints...). */
  evidence?: Readonly<Record<string, readonly string[]>>;
}

export function isStackId(value: string): value is StackId {
  return (STACK_IDS as readonly string[]).includes(value);
}

/** Split raw labels into known ids and unknown leftovers (never throws). */
export function partitionStacks(stacks: readonly string[]): {
  known: StackId[];
  unknown: string[];
} {
  const known: StackId[] = [];
  const unknown: string[] = [];
  for (const s of stacks) (isStackId(s) ? known : unknown).push(s);
  return { known, unknown };
}

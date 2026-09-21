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
import { STACK_IDS } from '@platform/stack-detect';
export { STACK_IDS };
export function isStackId(value) {
    return STACK_IDS.includes(value);
}
/** Split raw labels into known ids and unknown leftovers (never throws). */
export function partitionStacks(stacks) {
    const known = [];
    const unknown = [];
    for (const s of stacks)
        (isStackId(s) ? known : unknown).push(s);
    return { known, unknown };
}

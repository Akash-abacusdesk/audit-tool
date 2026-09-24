import { describe, expect, it } from 'vitest';
import { canTransitionUpdate, transitionUpdate, updatePromotePayload, updateSnapshotPayload, updateStagePayload } from '@platform/shared';

describe('S13 update-state machine (previously zero test coverage)', () => {
  it('walks the full happy path: discovered -> ... -> promoted', () => {
    let s = transitionUpdate('discovered', 'snapshot');
    expect(s).toBe('restore_point');
    s = transitionUpdate(s, 'stage', { stagingReady: true });
    expect(s).toBe('staging_validation');
    s = transitionUpdate(s, 'staging_passed');
    expect(s).toBe('functional_validation');
    s = transitionUpdate(s, 'functional_passed');
    expect(s).toBe('visual_validation');
    s = transitionUpdate(s, 'visual_passed');
    expect(s).toBe('approved');
    s = transitionUpdate(s, 'approve');
    expect(s).toBe('promoting');
    s = transitionUpdate(s, 'promote');
    expect(s).toBe('promoted');
  });

  it('every failure path routes to rollback, and rollback recovers to discovered', () => {
    for (const [from, event] of [
      ['staging_validation', 'staging_failed'],
      ['functional_validation', 'functional_failed'],
      ['visual_validation', 'visual_failed'],
      ['approved', 'reject'],
      ['promoting', 'promote_failed'],
    ] as const) {
      expect(transitionUpdate(from, event)).toBe('rollback');
    }
    expect(transitionUpdate('rollback', 'recovered')).toBe('discovered');
  });

  it('refuses staging validation before staging is ready (S11 gate) — fail closed', () => {
    expect(canTransitionUpdate('restore_point', 'stage', { stagingReady: false })).toBe(false);
    expect(() => transitionUpdate('restore_point', 'stage', { stagingReady: false })).toThrow(
      /staging is not ready|S11 safety gate/
    );
  });

  it('refuses every illegal transition (no direct blind production update)', () => {
    expect(() => transitionUpdate('discovered', 'promote')).toThrow(/illegal update transition/);
    expect(() => transitionUpdate('promoted', 'snapshot')).toThrow(/illegal update transition/);
    expect(() => transitionUpdate('staging_validation', 'approve')).toThrow(/illegal update transition/);
  });

  it('validates the three job payload shapes', () => {
    const updateUnitId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const environmentId = '33333333-3333-4333-8333-333333333333';
    expect(updateSnapshotPayload.parse({ updateUnitId, projectId, environmentId })).toBeTruthy();
    expect(updateStagePayload.parse({ updateUnitId })).toBeTruthy();
    expect(updatePromotePayload.parse({ updateUnitId })).toBeTruthy();
    expect(() => updateStagePayload.parse({ updateUnitId: 'not-a-uuid' })).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertStagingSafe,
  transitionStaging,
  stagingProvisionPayload,
  stagingTestRunPayload,
  stagingDestroyPayload,
} from '@platform/shared';

describe('S11 staging lifecycle state machine', () => {
  it('walks the happy path: requested -> provisioning -> ready -> destroying -> destroyed', () => {
    let state = transitionStaging('requested', 'provision');
    expect(state).toBe('provisioning');
    state = transitionStaging(state, 'provisioned');
    expect(state).toBe('ready');
    state = transitionStaging(state, 'destroy');
    expect(state).toBe('destroying');
    state = transitionStaging(state, 'destroyed');
    expect(state).toBe('destroyed');
  });

  it('routes provisioning failure to provision_failed, a terminal state', () => {
    const state = transitionStaging('provisioning', 'provision_failed');
    expect(state).toBe('provision_failed');
    expect(() => transitionStaging(state, 'provision')).toThrow(/illegal staging transition/);
  });

  it('fails closed on illegal transitions (e.g. destroy before ready)', () => {
    expect(() => transitionStaging('requested', 'destroy')).toThrow(/illegal staging transition/);
    expect(() => transitionStaging('provisioning', 'destroy')).toThrow(/illegal staging transition/);
  });
});

describe('S11 mandatory staging safety gate', () => {
  it('passes when PII is sanitized, integrations neutralized, and noindex is on', () => {
    expect(() =>
      assertStagingSafe({ piiSanitized: true, integrationsNeutralized: true, noindexEnabled: true })
    ).not.toThrow();
  });

  it('refuses closed and names every failed control', () => {
    expect(() =>
      assertStagingSafe({ piiSanitized: false, integrationsNeutralized: false, noindexEnabled: true })
    ).toThrow(/pii not sanitized.*integrations not neutralized/);
  });
});

describe('S11 staging job payloads', () => {
  const stagingId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const environmentId = '33333333-3333-4333-8333-333333333333';

  it('validates provision/test-run/destroy payload shapes', () => {
    expect(stagingProvisionPayload.parse({ stagingId, projectId, environmentId, ref: 'main' })).toBeTruthy();
    expect(stagingTestRunPayload.parse({ stagingId, suite: 'smoke' })).toBeTruthy();
    expect(stagingDestroyPayload.parse({ stagingId })).toBeTruthy();
    expect(() => stagingTestRunPayload.parse({ stagingId, suite: 'bogus' })).toThrow();
  });
});

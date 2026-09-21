/**
 * S3-D1 contract guards — the zod surface pam (ingress), angela (UI), dwight
 * (policy mapper) and oscar (abuse tests) compile against. Pure schema tests;
 * no DB, no stack.
 */
import { describe, expect, it } from 'vitest';
import {
  GIT_PROVIDERS,
  WEBHOOK_SIGNATURE_HEADERS,
  connectionCreateInput,
  policyAssignmentCreateInput,
  repoLinkCreateInput,
  stackDetectionRecordInput,
  stackDetectionResult,
  webhookEventIngest,
} from '@platform/shared';

const ORG = '11111111-1111-1111-1111-111111111111';
const PROJ = '22222222-2222-2222-2222-222222222222';
const CONN = '33333333-3333-3333-3333-333333333333';

describe('git provider connections', () => {
  it('accepts known providers, rejects unknown ones, requires orgId', () => {
    expect(
      connectionCreateInput.safeParse({ orgId: '0ee0c1b4-1d1d-4f8a-9a5e-2f6f6f6f6f6f', provider: 'github' })
        .success
    ).toBe(true);
    expect(connectionCreateInput.safeParse({ provider: 'github' }).success).toBe(false);
    expect(
      connectionCreateInput.safeParse({ orgId: '0ee0c1b4-1d1d-4f8a-9a5e-2f6f6f6f6f6f', provider: 'sourcehut' })
        .success
    ).toBe(false);
    expect(GIT_PROVIDERS.length).toBe(3);
  });

  it('signature-header map covers every provider exactly once', () => {
    expect(Object.keys(WEBHOOK_SIGNATURE_HEADERS).sort()).toEqual([...GIT_PROVIDERS].sort());
  });
});

describe('webhook ingestion record', () => {
  it('requires uuid connectionId and a verified flag', () => {
    const ok = webhookEventIngest.safeParse({
      connectionId: CONN,
      deliveryId: 'guid-1',
      eventType: 'push',
      verified: true,
      payload: { ref: 'main' },
    });
    expect(ok.success).toBe(true);

    const badConn = webhookEventIngest.safeParse({
      connectionId: 'not-a-uuid',
      deliveryId: 'guid-1',
      eventType: 'push',
      verified: true,
      payload: {},
    });
    expect(badConn.success).toBe(false);

    const badType = webhookEventIngest.safeParse({
      connectionId: CONN,
      deliveryId: 'guid-1',
      eventType: 'wiki.deleted',
      verified: true,
      payload: {},
    });
    expect(badType.success).toBe(false);
  });
});

describe('repo links', () => {
  it('enforces owner/name fullName shape', () => {
    const ok = repoLinkCreateInput.safeParse({
      projectId: PROJ,
      connectionId: CONN,
      externalRepoId: '42',
      fullName: 'acme/platform',
    });
    expect(ok.success).toBe(true);
    // default branch applied
    expect(ok.success && ok.data.defaultBranch).toBe('main');

    expect(
      repoLinkCreateInput.safeParse({
        projectId: PROJ,
        connectionId: CONN,
        externalRepoId: '42',
        fullName: 'no-slash',
      }).success
    ).toBe(false);
  });
});

describe('stack detection', () => {
  it('mirrors kevin wire contract verbatim', () => {
    const det = stackDetectionResult.safeParse({
      stacks: ['nextjs', 'strapi'],
      headless: true,
      evidence: { markers: ['next.config.js'] },
    });
    expect(det.success).toBe(true);
  });

  it('rejects unknown stack kinds in persistence input', () => {
    const r = stackDetectionRecordInput.safeParse({
      stacks: ['django'],
      headless: false,
      evidence: null,
      projectId: PROJ,
      detectorVersion: 'v1',
    });
    expect(r.success).toBe(false);
  });

  it('validates sourceCommitSha as short-or-full hex when present', () => {
    const short = stackDetectionRecordInput.safeParse({
      stacks: [],
      headless: false,
      evidence: {},
      projectId: PROJ,
      sourceCommitSha: 'abc1234',
      detectorVersion: 'v1',
    });
    expect(short.success).toBe(true);

    const bad = stackDetectionRecordInput.safeParse({
      stacks: [],
      headless: false,
      evidence: {},
      projectId: PROJ,
      sourceCommitSha: 'zzzzzz',
      detectorVersion: 'v1',
    });
    expect(bad.success).toBe(false);
  });
});

describe('policy assignments', () => {
  it('defaults enabled=true and allows org-only scope', () => {
    const r = policyAssignmentCreateInput.safeParse({ policyId: 'require-signed-commits', orgId: ORG });
    expect(r.success).toBe(true);
    expect(r.success && r.data.enabled).toBe(true);
  });

  it('requires a non-empty policy key', () => {
    expect(
      policyAssignmentCreateInput.safeParse({ policyId: '', orgId: ORG }).success
    ).toBe(false);
  });
});

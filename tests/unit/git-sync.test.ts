/**
 * S3-D1B unit guards: pure logic only (no DB, no network) — secretbox crypto,
 * GitHub wire-shape mappers, PR state derivation.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  loadCredentialsKey,
} from '../../apps/api/src/git/secretbox.js';
import {
  derivePrState,
  fetchRepoSnapshot,
  mapBranch,
  mapCommit,
  mapPullRequest,
} from '../../apps/api/src/git/github.js';

const KEY = loadCredentialsKey('ab'.repeat(32));

describe('credential secretbox', () => {
  it('round-trips a token', () => {
    const token = 'ghp_test-token-123';
    const ct = encryptToken(token, KEY);
    expect(ct).not.toContain(token);
    expect(decryptToken(ct, KEY)).toBe(token);
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const ct = encryptToken('secret', KEY);
    const raw = Buffer.from(ct, 'base64');
    raw[raw.length - 1]! ^= 0xff;
    expect(decryptToken(raw.toString('base64'), KEY)).toBeNull();
    const otherKey = loadCredentialsKey('cd'.repeat(32));
    expect(decryptToken(ct, otherKey)).toBeNull();
    expect(decryptToken('not-base64!!', KEY)).toBeNull();
  });

  it('enforces key length', () => {
    expect(() => loadCredentialsKey('short')).toThrow(/64 hex/);
    expect(() => loadCredentialsKey('')).toThrow(/64 hex/);
  });
});

describe('github mappers', () => {
  it('maps a branch', () => {
    expect(mapBranch({ name: 'main', commit: { sha: 'a'.repeat(40) } })).toEqual({
      name: 'main',
      headSha: 'a'.repeat(40),
    });
    expect(mapBranch({ name: 'x', commit: {} })!.headSha).toBeNull();
    expect(mapBranch({ commit: { sha: 'a' } })).toBeNull(); // no name
    expect(mapBranch(null)).toBeNull();
  });

  it('maps a commit with tolerable holes', () => {
    const full = mapCommit({
      sha: 'c'.repeat(40),
      commit: {
        author: { email: 'a@b.c' },
        committer: { date: '2026-08-20T10:00:00Z' },
        message: 'msg',
      },
    })!;
    expect(full.authorEmail).toBe('a@b.c');
    expect(full.committedAt?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
    const bare = mapCommit({ sha: 'd'.repeat(7), commit: {} })!;
    expect(bare.authorEmail).toBeNull();
    expect(bare.committedAt).toBeNull();
    expect(mapCommit({ sha: 'nothex' })).toBeNull();
  });

  it('derives PR tri-state', () => {
    expect(derivePrState('open', null)).toBe('open');
    expect(derivePrState('closed', '2026-01-01T00:00:00Z')).toBe('merged');
    expect(derivePrState('closed', null)).toBe('closed');
  });

  it('maps a PR', () => {
    const pr = mapPullRequest({
      number: 7,
      state: 'closed',
      merged_at: '2026-08-19T10:00:00Z',
      title: 'T',
      head: { ref: 'feat', sha: 'e'.repeat(40) },
      base: { ref: 'main' },
      updated_at: '2026-08-19T09:00:00Z',
    })!;
    expect(pr.state).toBe('merged');
    expect(pr.externalId).toBe('7');
    expect(pr.sourceBranch).toBe('feat');
    expect(mapPullRequest({})).toEqual({
      externalId: 'undefined',
      sourceBranch: '',
      targetBranch: '',
      state: 'closed',
      title: null,
      headSha: null,
      updatedAt: new Date(0),
    });
  });
});

describe('fetchRepoSnapshot transport', () => {
  it('sends bearer + maps all three endpoints via injected fetch', async () => {
    const seen: string[] = [];
    const stub: typeof fetch = async (input, init) => {
      seen.push(`${input} auth=${(init?.headers as Record<string, string>).authorization}`);
      const path = String(input);
      const body = path.includes('/branches')
        ? [{ name: 'main', commit: { sha: 'a'.repeat(40) } }]
        : path.includes('/commits')
          ? []
          : [];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const snap = await fetchRepoSnapshot({
      fullName: 'octo/hello',
      token: 'tok',
      baseUrl: 'http://stub.invalid',
      fetchImpl: stub,
    });
    expect(snap.branches).toHaveLength(1);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('auth=Bearer tok');
  });

  it('throws on provider error status', async () => {
    const stub: typeof fetch = async () => new Response('{}', { status: 404 });
    await expect(
      fetchRepoSnapshot({ fullName: 'octo/missing', baseUrl: 'http://stub.invalid', fetchImpl: stub })
    ).rejects.toThrow(/404/);
  });
});

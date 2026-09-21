import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectStacks, type StackId } from '@platform/stack-detect';

const repo = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/repos/${name}`, import.meta.url));

describe('detectStacks', () => {
  const single = async (fixture: string, stack: StackId): Promise<void> => {
    const res = await detectStacks(repo(fixture));
    expect(res.stacks).toEqual([stack]);
    expect(res.headless).toBe(false);
    expect(res.evidence[stack]?.length).toBeGreaterThan(0);
  };

  it('nextjs: dependency "next"', () => single('nextjs-basic', 'nextjs'));
  it('wordpress: wp-config.php', () => single('wordpress-basic', 'wordpress'));
  it('payload: dep + payload.config.ts', () => single('payload-basic', 'payload'));
  it('directus: dependency', () => single('directus-basic', 'directus'));
  it('strapi: dep + config/plugins.js + api/', () => single('strapi-basic', 'strapi'));

  it('headless: next + payload', async () => {
    const res = await detectStacks(repo('headless-next-payload'));
    expect(res.stacks).toContain('nextjs');
    expect(res.stacks).toContain('payload');
    expect(res.headless).toBe(true);
  });

  it('headless: next + wordpress (wp-content marker)', async () => {
    const res = await detectStacks(repo('headless-next-wordpress'));
    expect(res.stacks).toContain('nextjs');
    expect(res.stacks).toContain('wordpress');
    expect(res.headless).toBe(true);
    // dir-only wordpress detection carries evidence
    expect(res.evidence.wordpress).toContain('dir: wp-content/');
  });

  it('empty repo: nothing detected', async () => {
    const res = await detectStacks(repo('empty'));
    expect(res.stacks).toEqual([]);
    expect(res.headless).toBe(false);
    expect(res.evidence).toEqual({});
  });

  it('missing root behaves like empty repo (no throw)', async () => {
    const res = await detectStacks(join(repo('empty'), 'does-not-exist'));
    expect(res.stacks).toEqual([]);
    expect(res.headless).toBe(false);
  });
});

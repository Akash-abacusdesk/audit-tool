import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { detectCrossStack } from '../../../packages/scanner/src/detectors/crossstack.js';
import { runScan } from '../../../packages/scanner/src/index.js';

// The S6 headless fixtures are generated (not committed). Ensure they exist so
// the in-place scan has something to read on a clean checkout.
async function ensureHeadlessFixtures() {
  const base = join(process.cwd(), 'tests/fixtures/headless');
  if (!existsSync(join(base, 'nextjs-wordpress'))) {
    await import('../../fixtures/gen-s6-fixtures.mjs');
  }
}

const ctx = { tool: 'crossstack', target: { kind: 'repo' as const, ref: 'repo-cross', branch: 'main' } };

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crossstack-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

const sample = {
  'page.tsx': `'use client';\nimport { wp } from './wp';\nexport default function Page() {\n  const AKIAW2abcdefghijklmn = 'AKIAW2abcdefghijklmn';\n  return fetch('https://cms.example/wp-json/wp/v2/posts?token=abc123');\n}\n`,
  '.env.local': `NEXT_PUBLIC_SITE_URL=https://x.com\nNEXT_PUBLIC_STRIPE_SECRET=sk-live-abcdefghijklmnopqrstuvwxyz\n`,
  'cms.ts': `export async function posts() {\n  const ADMIN_TOKEN="supersecretadminvalue123";\n  return fetch('https://cms.example/wp-json/wp/v2/posts');\n}\n`,
  'queries.ts': `export const Q = \`query { user { id password token secret } }\`;\n`,
  'benign.ts': `const greeting = "hello";\nconst url = process.env.NEXT_PUBLIC_SITE_URL;\n`,
};

describe('detectCrossStack', () => {
  it('flags all five rule families and redacts evidence', async () => {
    const dir = await fixture(sample);
    const f = await detectCrossStack(dir, ctx);
    const byRule = (r: string) => f.filter((x) => x.rule_id === r);

    expect(byRule('crossstack.next-public-secret').length).toBeGreaterThan(0);
    expect(byRule('crossstack.next-public-secret')[0].severity).toBe('high');

    expect(byRule('crossstack.admin-token-exposure').length).toBeGreaterThan(0);

    expect(byRule('crossstack.rest-graphql-secret-exposure').length).toBeGreaterThan(0);

    const cms = byRule('crossstack.nextjs-cms-trust-boundary');
    expect(cms.length).toBeGreaterThan(0);
    // client-side CMS usage with a secret rides at high
    expect(cms.some((x) => x.severity === 'high')).toBe(true);

    expect(byRule('crossstack.client-bundle-secret').length).toBeGreaterThan(0);
    expect(byRule('crossstack.client-bundle-secret')[0].evidence).toContain('<redacted:');

    await rm(dir, { recursive: true, force: true });
  });

  it('produces no findings on a benign file', async () => {
    const dir = await fixture({ 'benign.ts': sample['benign.ts'] });
    const f = await detectCrossStack(dir, ctx);
    // NEXT_PUBLIC_SITE_URL is not secret-named -> no next-public-secret; no literals.
    expect(f.filter((x) => x.rule_id === 'crossstack.next-public-secret')).toHaveLength(0);
    expect(f).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('uses a stable dedup key per (rule, path, line)', async () => {
    const dir = await fixture({ 'a.ts': sample['cms.ts'] });
    const f = await detectCrossStack(dir, ctx);
    const fps = new Set(f.map((x) => x.finding_fingerprint));
    expect(fps.size).toBe(f.length); // no duplicate fingerprints
    await rm(dir, { recursive: true, force: true });
  });
});

describe('runScan (rules dispatch)', () => {
  beforeAll(ensureHeadlessFixtures);

  it('runs the crossstack detector through the shared run contract', async () => {
    const dir = await fixture(sample);
    const env = await runScan(
      {
        scanId: 'scan-cs',
        projectId: '11111111-1111-1111-1111-111111111111',
        tool: 'crossstack',
        workspaceDir: dir,
        target: ctx.target,
      },
      { keepOutDir: true },
    );
    expect(env.tool.name).toBe('crossstack');
    expect(env.status).toBe('completed');
    expect(env.findings.some((x) => x.rule_id === 'crossstack.next-public-secret')).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('detects generic cross-stack rules in the S6 headless fixtures', async () => {
    const cases = ['nextjs-wordpress', 'nextjs-payload', 'nextjs-directus', 'nextjs-strapi'];
    for (const name of cases) {
      const env = await runScan({
        scanId: `scan-${name}`,
        projectId: '11111111-1111-1111-1111-111111111111',
        tool: 'crossstack',
        workspaceDir: join(process.cwd(), 'tests/fixtures/headless', name),
        target: { kind: 'repo', ref: name },
      });
      expect(env.findings.some((x) => x.rule_id === 'crossstack.next-public-secret')).toBe(true);
      expect(env.findings.some((x) => x.rule_id === 'crossstack.nextjs-cms-trust-boundary')).toBe(true);
    }

    const clean = await runScan({
      scanId: 'scan-clean',
      projectId: '11111111-1111-1111-1111-111111111111',
      tool: 'crossstack',
      workspaceDir: join(process.cwd(), 'tests/fixtures/headless/clean'),
      target: { kind: 'repo', ref: 'clean' },
    });
    expect(clean.findings).toHaveLength(0);
  });
});

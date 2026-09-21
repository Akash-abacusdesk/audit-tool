/**
 * S3-D3 unit tests — stack -> security-policy mapper (table-driven).
 * Pure functions: no DB, no docker, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  DENY_BY_DEFAULT_POLICY,
  MAPPER_VERSION,
  mapStacksToPolicies,
  partitionStacks,
  type DetectionInput,
} from '@platform/shared';

const base = (over: Partial<DetectionInput>): DetectionInput => ({
  project_id: 'p1',
  stacks: [],
  headless: false,
  ...over,
});

interface Row {
  name: string;
  input: DetectionInput;
  expectStacks: string[];
  expectMode?: 'enforce' | 'deny-until-manual-review';
  expectManualReview?: boolean;
  check?: (r: ReturnType<typeof mapStacksToPolicies>) => void;
}

const rows: Row[] = [
  // --- every canonical stack, singly ---
  {
    name: 'nextjs solo -> enforce, no cms surface',
    input: base({ stacks: ['nextjs'] }),
    expectStacks: ['nextjs'],
    expectMode: 'enforce',
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p.scan_cadence.sast).toBe('on-push');
      expect(p.scan_cadence.cms_vuln).toBe('manual');
      expect(p.auth_surface.cms_admin_exposed).toBe(false);
      expect(p.update_surface).toBeUndefined();
    },
  },
  {
    name: 'wordpress solo -> enforce, daily wpscan correlation + safe-update surface',
    input: base({ stacks: ['wordpress'] }),
    expectStacks: ['wordpress'],
    expectMode: 'enforce',
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p.scan_cadence.cms_vuln).toBe('daily');
      expect(p.update_surface).toBe('safe-update-engine-only');
      expect(p.auth_surface.cms_admin_exposed).toBe(true);
      expect(p.runs_on).not.toContain('production-website-vps');
    },
  },
  {
    name: 'payload solo -> enforce node-cms profile',
    input: base({ stacks: ['payload'] }),
    expectStacks: ['payload'],
    expectMode: 'enforce',
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p.cms_hardening_profile).toBe('node-cms-hardening-v1');
      expect(p.scan_cadence.sca).toBe('daily');
    },
  },
  {
    name: 'directus solo -> enforce node-cms profile',
    input: base({ stacks: ['directus'] }),
    expectStacks: ['directus'],
    expectMode: 'enforce',
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p.cms_hardening_profile).toBe('node-cms-hardening-v1');
      expect(p.auth_surface.api_public).toBe(true);
    },
  },
  {
    name: 'strapi solo -> enforce node-cms profile',
    input: base({ stacks: ['strapi'] }),
    expectStacks: ['strapi'],
    expectMode: 'enforce',
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p.cms_hardening_profile).toBe('node-cms-hardening-v1');
      expect(p.rationale.length).toBeGreaterThan(0);
    },
  },

  // --- unknown-stack fallback: deny-by-default ---
  {
    name: 'unknown stack solo -> deny-until-manual-review, nothing scheduled',
    input: base({ stacks: ['cobol-mainframe'] }),
    expectStacks: ['unknown'],
    expectMode: 'deny-until-manual-review',
    expectManualReview: true,
    check: (r) => {
      const p = r.assignments[0]!.policy;
      expect(p).toEqual(DENY_BY_DEFAULT_POLICY);
      expect(Object.values(p.scan_cadence).every((c) => c === 'manual')).toBe(true);
      expect(p.auth_surface.cms_admin_exposed).toBe(true); // worst-case assumption
    },
  },
  {
    name: 'known + unknown mix -> both assigned, manual review flagged',
    input: base({ stacks: ['nextjs', 'drupal'] }),
    expectStacks: ['nextjs', 'unknown'],
    expectManualReview: true,
  },
  {
    name: 'duplicate labels collapse to one assignment each',
    input: base({ stacks: ['wordpress', 'wordpress', 'mystery'] }),
    expectStacks: ['wordpress', 'unknown'],
  },

  // --- headless combos ---
  {
    name: 'headless nextjs+wordpress with full evidence -> gates pass',
    input: base({
      stacks: ['nextjs', 'wordpress'],
      headless: true,
      evidence: {
        frontend_project_id: ['proj-a'],
        backend_project_id: ['proj-b'],
        'api_protocol(rest|graphql)': ['rest'],
      },
    }),
    expectStacks: ['nextjs', 'wordpress'],
    expectManualReview: false,
    check: (r) => {
      expect(r.cross_stack_gates.length).toBe(4);
      expect(r.cross_stack_gates.every((g) => g.satisfied)).toBe(true);
    },
  },
  {
    name: 'headless nextjs+payload missing metadata -> needs review',
    input: base({ stacks: ['nextjs', 'payload'], headless: true }),
    expectStacks: ['nextjs', 'payload'],
    expectManualReview: true,
    check: (r) => {
      expect(r.cross_stack_gates.filter((g) => !g.satisfied)).toHaveLength(3);
    },
  },
  {
    name: 'headless flag without backend pair -> gate fails',
    input: base({ stacks: ['nextjs'], headless: true }),
    expectStacks: ['nextjs'],
    expectManualReview: true,
    check: (r) => {
      expect(r.cross_stack_gates[0]).toMatchObject({
        gate: 'headless-pair-present',
        satisfied: false,
      });
    },
  },
  {
    name: 'not headless -> no cross gates at all',
    input: base({ stacks: ['strapi'] }),
    expectStacks: ['strapi'],
    expectManualReview: false,
    check: (r) => expect(r.cross_stack_gates).toEqual([]),
  },

  // --- degenerate inputs ---
  {
    name: 'empty stacks -> no assignments, no review',
    input: base({}),
    expectStacks: [],
    expectManualReview: false,
  },
];

describe('mapStacksToPolicies (table-driven)', () => {
  for (const row of rows) {
    it(row.name, () => {
      const r = mapStacksToPolicies(row.input);
      expect(r.project_id).toBe(row.input.project_id);
      expect(r.mapper_version).toBe(MAPPER_VERSION);
      expect(r.assignments.map((a) => a.stack)).toEqual(row.expectStacks);
      if (row.expectMode)
        expect(r.assignments.every((a) => a.policy.mode === row.expectMode)).toBe(
          true
        );
      if (row.expectManualReview !== undefined)
        expect(r.needs_manual_review).toBe(row.expectManualReview);
      row.check?.(r);
    });
  }
});

describe('partitionStacks', () => {
  it('routes raw labels to known/unknown without throwing', () => {
    expect(partitionStacks(['nextjs', 'nope', 'wordpress'])).toEqual({
      known: ['nextjs', 'wordpress'],
      unknown: ['nope'],
    });
  });
});

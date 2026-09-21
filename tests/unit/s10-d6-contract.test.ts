import { describe, it, expect } from 'vitest';
import { findingInput } from '@platform/shared';
import {
  ADVISORIES,
  VULNERABLE_FIXTURES,
  PATCHED_FIXTURES,
  correlate,
  runValidation,
  wpInventorySchema,
  wpAdvisorySchema,
} from '../fixtures/wp-vuln-fixtures.mjs';

function assertShape(obj: unknown, schema: { type: string[]; required: string[] }, label: string) {
  const o = obj as Record<string, unknown>;
  expect(schema.type.includes(o.type as string), `${label}: type ${o.type}`).toBe(true);
  for (const k of schema.required) {
    expect(o[k], `${label}: missing ${k}`).not.toBeUndefined();
  }
}

describe('S10-D6 fixture corpus is well-formed and aligned to S10-D4/S10-D3 contracts', () => {
  it('every inventory fixture (Kevin S10-D4 shape) is valid', () => {
    for (const f of [...VULNERABLE_FIXTURES, ...PATCHED_FIXTURES]) {
      assertShape(f.component, wpInventorySchema, f.label);
    }
  });

  it('every advisory (Dwight S10-D3 shape) is valid', () => {
    for (const a of ADVISORIES) assertShape(a, wpAdvisorySchema, a.slug);
  });

  it('self-validation: vulnerable->finding, patched->0 (reference oracle)', () => {
    expect(runValidation(), 'fixture corpus oracle gaps').toBe(0);
  });
});

describe('S10-D6 correlation produces Section-10 validation-check findings (846-851)', () => {
  for (const f of VULNERABLE_FIXTURES) {
    it(`${f.label}: known-vulnerable version -> expected finding (CVE + fixed-version shown)`, () => {
      const findings = correlate([f.component], ADVISORIES);
      // An old version may be vulnerable to multiple CVEs -> multiple findings.
      expect(findings.length, `${f.label}: no findings`).toBeGreaterThanOrEqual(1);

      // Every emitted finding must conform to the live FindingInput sink contract.
      for (const x of findings) {
        const p = findingInput.safeParse(x);
        expect(p.success, JSON.stringify(p)).toBe(true);
      }

      const got = findings.find((x) => JSON.stringify(x.cve_ids) === JSON.stringify(f.expect.cve_ids));
      expect(got, `${f.label}: expected ${f.expect.cve_ids} not produced`).toBeTruthy();

      // Validation check 849: advisory/CVE correlation creates the expected finding.
      expect(got!.severity).toBe(f.expect.severity);
      expect(got!.cve_ids).toEqual(f.expect.cve_ids);
      expect(got!.advisory_ids).toEqual(f.expect.advisory_ids);
      // Validation check 850: fixed-version information is shown when available.
      expect(got!.remediation?.summary).toContain(f.expect.fixed_in);
      expect(got!.finding_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  for (const f of PATCHED_FIXTURES) {
    it(`${f.label}: non-vulnerable version -> NO false-positive finding (851)`, () => {
      const findings = correlate([f.component], ADVISORIES);
      expect(findings, `false positive for ${f.label}`).toHaveLength(0);
    });
  }
});

// Skip-gated: when Dwight's real S10-D3 correlation module is importable (CI after
// his card lands), run the SAME assertions against it instead of the reference
// oracle. Keeps this deliverable green today and a true contract test once wired.
let liveCorrelate: typeof correlate | null = null;
try {
  const mod = (await import(
    process.env.S10_CORRELATION_MODULE ?? '@platform/cms-vuln'
  )) as { correlate?: typeof correlate };
  if (typeof mod.correlate === 'function') liveCorrelate = mod.correlate;
} catch {
  /* S10-D3 not built yet — reference oracle path is authoritative */
}

if (liveCorrelate) {
  describe('S10-D6 against Dwight S10-D3 live correlation module', () => {
    for (const f of VULNERABLE_FIXTURES) {
      it(`${f.label} (live): emits expected CVE + severity + fixed-in`, () => {
        const findings = liveCorrelate!([f.component], ADVISORIES);
        expect(findings.length).toBeGreaterThanOrEqual(1);
        const got = findings[0];
        const parsed = findingInput.safeParse(got);
        expect(parsed.success, JSON.stringify(parsed)).toBe(true);
        expect(got.severity).toBe(f.expect.severity);
        expect(got.cve_ids ?? []).toEqual(expect.arrayContaining(f.expect.cve_ids));
        expect(
          (got.remediation?.summary ?? '') + JSON.stringify(got.metadata ?? {}),
        ).toContain(f.expect.fixed_in);
      });
    }
    for (const f of PATCHED_FIXTURES) {
      it(`${f.label} (live): no false positive`, () => {
        expect(liveCorrelate!([f.component], ADVISORIES)).toHaveLength(0);
      });
    }
  });
}

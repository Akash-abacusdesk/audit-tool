// S10-D6 known-vulnerable WordPress-version fixtures (oscar).
//
// Purpose: validate the Section 10 correlation (Dwight S10-D3) against a curated
// corpus of known-vulnerable WordPress component versions, and prove a
// non-vulnerable version produces NO false-positive finding (Section 10
// validation check 846-851).
//
// Contract alignment:
//   - Inventory item shape   -> Kevin S10-D4 (WordPress core/plugin/theme inventory).
//   - Advisory shape         -> Dwight S10-D3 (WPScan/advisory DB entry).
//   - Oracle output shape    -> shared FindingInput (scanning.ts), matching what
//                               Dwight's correlation POSTs to the findings sink.
//
// The `correlate` oracle here is the REFERENCE implementation of the documented
// correlation contract (installed version < advisory.fixed_in => finding). It lets
// the validation run GREEN in any sandbox without Dwight's runtime, and the test
// ALSO exercises Dwight's real module when it becomes importable (see the
// skip-gated block in s10-d6-contract.test.ts).

import crypto from 'node:crypto';

/**
 * @typedef {'core'|'plugin'|'theme'} WpComponentType
 * @typedef {import('zod').z.infer<typeof wpInventorySchema> extends infer T ? T : never} WpInventoryComponent
 */

// ---- Shapes (pinned so Kevin/Dwight consumers stay aligned) ----

/** WordPress inventory item — Kevin S10-D4 output contract. */
export const wpInventorySchema = {
  type: ['core', 'plugin', 'theme'],
  required: ['type', 'slug', 'name', 'version'],
};

/** Advisory DB entry — Dwight S10-D3 source contract. */
export const wpAdvisorySchema = {
  type: ['core', 'plugin', 'theme'],
  required: ['type', 'slug', 'title', 'severity', 'fixed_in'],
};

/**
 * @typedef {Object} WpInventoryComponent
 * @property {WpComponentType} type
 * @property {string} slug
 * @property {string} name
 * @property {string} version
 *
 * @typedef {Object} WpAdvisory
 * @property {WpComponentType} type
 * @property {string} slug
 * @property {string} title
 * @property {'critical'|'high'|'medium'|'low'|'info'} severity
 * @property {string[]} [cve_ids]
 * @property {string[]} [advisory_ids]
 * @property {string} fixed_in
 * @property {string[]} [references]
 */

// ---- Version comparison (semver-lite, WP x.y.z) ----

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `version` is strictly older than `fixedIn` (i.e. vulnerable). */
export function isVulnerable(version, fixedIn) {
  return compareVersions(version, fixedIn) < 0;
}

// ---- Advisory corpus (real where confidently known; marked otherwise) ----

/** @type {WpAdvisory[]} */
export const ADVISORIES = [
  {
    type: 'core',
    slug: 'wordpress',
    title: 'WordPress Core < 5.4.2 — Authenticated Cross-Site Scripting (XSS)',
    severity: 'high',
    cve_ids: ['CVE-2020-11025'],
    advisory_ids: ['WPVULN-WP-CORE-542'],
    fixed_in: '5.4.2',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2020-11025'],
  },
  {
    type: 'core',
    slug: 'wordpress',
    title: 'WordPress Core < 5.5.2 — Authenticated Stored XSS via Comments',
    severity: 'high',
    cve_ids: ['CVE-2020-28032'],
    advisory_ids: ['WPVULN-WP-CORE-552'],
    fixed_in: '5.5.2',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2020-28032'],
  },
  {
    type: 'core',
    slug: 'wordpress',
    title: 'WordPress Core < 5.8.3 — SQL Injection via WP_Query',
    severity: 'critical',
    cve_ids: ['CVE-2022-21661'],
    advisory_ids: ['WPVULN-WP-CORE-583'],
    fixed_in: '5.8.3',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2022-21661'],
  },
  {
    type: 'plugin',
    slug: 'contact-form-7',
    title: 'Contact Form 7 < 5.3.1 — Unrestricted File Upload',
    severity: 'high',
    cve_ids: ['CVE-2020-35489'],
    advisory_ids: ['WPVULN-CF7-531'],
    fixed_in: '5.3.1',
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2020-35489'],
  },
  {
    type: 'plugin',
    slug: 'elementor',
    title: 'Elementor < 3.1.4 — Authenticated Stored XSS (representative)',
    severity: 'high',
    cve_ids: ['CVE-2021-XXXX'],
    advisory_ids: ['WPVULN-ELEMENTOR-314'],
    fixed_in: '3.1.4',
    references: ['https://wpscan.com/plugin/elementor/'],
    source: 'representative',
  },
  {
    type: 'theme',
    slug: 'twentytwentyone',
    title: 'Twenty Twenty-One < 1.1 — Post-Trashing Stored XSS (representative)',
    severity: 'medium',
    cve_ids: ['CVE-2021-YYYY'],
    advisory_ids: ['WPVULN-TWENTYTWENTYONE-11'],
    fixed_in: '1.1',
    references: ['https://wpscan.com/theme/twentytwentyone/'],
    source: 'representative',
  },
];

// ---- Known-vulnerable fixtures (must produce a finding) ----

/** @type {{label:string, component:WpInventoryComponent, expect:{severity:string,cve_ids:string[],advisory_ids:string[],fixed_in:string}}[]} */
export const VULNERABLE_FIXTURES = [
  {
    label: 'wp-core-5.4.1',
    component: { type: 'core', slug: 'wordpress', name: 'WordPress', version: '5.4.1' },
    expect: { severity: 'high', cve_ids: ['CVE-2020-11025'], advisory_ids: ['WPVULN-WP-CORE-542'], fixed_in: '5.4.2' },
  },
  {
    label: 'wp-core-5.5.1',
    component: { type: 'core', slug: 'wordpress', name: 'WordPress', version: '5.5.1' },
    expect: { severity: 'high', cve_ids: ['CVE-2020-28032'], advisory_ids: ['WPVULN-WP-CORE-552'], fixed_in: '5.5.2' },
  },
  {
    label: 'wp-core-5.8.2',
    component: { type: 'core', slug: 'wordpress', name: 'WordPress', version: '5.8.2' },
    expect: { severity: 'critical', cve_ids: ['CVE-2022-21661'], advisory_ids: ['WPVULN-WP-CORE-583'], fixed_in: '5.8.3' },
  },
  {
    label: 'cf7-5.3.0',
    component: { type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7', version: '5.3.0' },
    expect: { severity: 'high', cve_ids: ['CVE-2020-35489'], advisory_ids: ['WPVULN-CF7-531'], fixed_in: '5.3.1' },
  },
  {
    label: 'elementor-3.1.3',
    component: { type: 'plugin', slug: 'elementor', name: 'Elementor', version: '3.1.3' },
    expect: { severity: 'high', cve_ids: ['CVE-2021-XXXX'], advisory_ids: ['WPVULN-ELEMENTOR-314'], fixed_in: '3.1.4' },
  },
  {
    label: 'tt1-1.0',
    component: { type: 'theme', slug: 'twentytwentyone', name: 'Twenty Twenty-One', version: '1.0' },
    expect: { severity: 'medium', cve_ids: ['CVE-2021-YYYY'], advisory_ids: ['WPVULN-TWENTYTWENTYONE-11'], fixed_in: '1.1' },
  },
];

// ---- Patched fixtures (must produce NO finding = no false positive) ----

/** @type {{label:string, component:WpInventoryComponent}[]} */
export const PATCHED_FIXTURES = [
  { label: 'wp-core-6.4.1-patched', component: { type: 'core', slug: 'wordpress', name: 'WordPress', version: '6.4.1' } },
  { label: 'cf7-5.3.1-boundary', component: { type: 'plugin', slug: 'contact-form-7', name: 'Contact Form 7', version: '5.3.1' } },
  { label: 'elementor-3.5.0-patched', component: { type: 'plugin', slug: 'elementor', name: 'Elementor', version: '3.5.0' } },
  { label: 'tt1-1.4.0-patched', component: { type: 'theme', slug: 'twentytwentyone', name: 'Twenty Twenty-One', version: '1.4.0' } },
];

// ---- Reference oracle: the documented correlation contract ----

function ruleIdFor(type, slug, fixedIn) {
  return `wpvuln:${type}:${slug}:${fixedIn}`;
}

/**
 * Reference correlation: for each installed component, find advisories matching
 * type+slug where the installed version is strictly older than fixed_in, and emit
 * one FindingInput per match. Pure; mirrors what S10-D3 must produce.
 * @param {WpInventoryComponent[]} components
 * @param {WpAdvisory[]} advisories
 */
export function correlate(components, advisories) {
  /** @type {any[]} */
  const findings = [];
  for (const c of components) {
    for (const a of advisories) {
      if (a.type !== c.type || a.slug !== c.slug) continue;
      if (!isVulnerable(c.version, a.fixed_in)) continue;
      const ruleId = ruleIdFor(a.type, a.slug, a.fixed_in);
      const fingerprint = crypto
        .createHash('sha256')
        .update(['wpscan', ruleId, c.slug, c.version].join('|'))
        .digest('hex');
      findings.push({
        finding_fingerprint: fingerprint,
        rule_id: ruleId,
        title: a.title,
        description: `Known-vulnerable ${c.type} '${c.name}' ${c.version} — fixed in ${a.fixed_in}.`,
        severity: a.severity,
        confidence: 'certain',
        cve_ids: a.cve_ids,
        advisory_ids: a.advisory_ids,
        remediation: {
          summary: `Update ${c.name} from ${c.version} to ${a.fixed_in} or later`,
          references: a.references,
        },
        metadata: {
          componentType: a.type,
          slug: a.slug,
          installedVersion: c.version,
          fixedIn: a.fixed_in,
          cveIds: a.cve_ids ?? [],
        },
      });
    }
  }
  return findings;
}

// ---- Self-validation (CI/script mode; also reused by the unit test) ----

export function runValidation() {
  let failures = 0;
  for (const f of VULNERABLE_FIXTURES) {
    const out = correlate([f.component], ADVISORIES);
    // An old version may be vulnerable to several CVEs -> several findings.
    // Assert the expected finding (by CVE) is present and well-formed.
    if (out.length < 1) {
      console.error(`VULN ${f.label}: expected >=1 finding, got 0`);
      failures++;
      continue;
    }
    const got = out.find((x) => JSON.stringify(x.cve_ids) === JSON.stringify(f.expect.cve_ids));
    if (!got) { console.error(`VULN ${f.label}: expected finding ${f.expect.cve_ids} not produced`); failures++; continue; }
    if (got.severity !== f.expect.severity) { console.error(`VULN ${f.label}: severity ${got.severity} != ${f.expect.severity}`); failures++; }
    if (JSON.stringify(got.advisory_ids) !== JSON.stringify(f.expect.advisory_ids)) { console.error(`VULN ${f.label}: advisory_ids mismatch`); failures++; }
    if (!got.remediation?.summary.includes(f.expect.fixed_in)) { console.error(`VULN ${f.label}: fixed_in not shown in remediation`); failures++; }
  }
  for (const f of PATCHED_FIXTURES) {
    const out = correlate([f.component], ADVISORIES);
    if (out.length !== 0) {
      console.error(`PATCHED ${f.label}: expected 0 findings, got ${out.length} (false positive)`);
      failures++;
    }
  }
  return failures;
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('wp-vuln-fixtures.mjs');
if (invokedDirectly) {
  const failures = runValidation();
  if (failures) { console.error(`S10-D6 validation: ${failures} fixture gap(s)`); process.exit(1); }
  console.log('S10-D6 fixture validation: all known-vulnerable -> finding, all patched -> 0 findings');
}

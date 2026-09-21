import type { FindingInput, Severity } from '@platform/shared';
import { makeFingerprint } from '../normalize.js';
import { isVulnerable, compareVersions } from './version.js';
import type {
  WpAdvisory,
  WpComponentType,
  WpInventory,
  WpInstalledComponent,
  WpVulnFindingMeta,
  UpdateRisk,
} from './types.js';

const TOOL = 'wp-vuln-intel';

function primaryId(a: WpAdvisory): string {
  return a.cve_ids?.[0] ?? a.advisory_ids?.[0] ?? a.slug;
}

function majorJump(installed: string, fixed: string | undefined): boolean {
  if (!fixed) return false;
  const i = Number.parseInt(installed.split('.')[0] ?? '0', 10);
  const f = Number.parseInt(fixed.split('.')[0] ?? '0', 10);
  return i !== f;
}

function buildFinding(
  type: WpComponentType,
  comp: WpInstalledComponent,
  adv: WpAdvisory,
  targetRef: string,
): FindingInput {
  const id = primaryId(adv);
  const ruleId = `${TOOL}.${type}.${adv.slug}.${id}`;
  const active = comp.active ?? true;
  const risk: UpdateRisk = adv.update_risk?.risk ?? 'medium';
  const meta: WpVulnFindingMeta = {
    componentType: type,
    slug: adv.slug,
    installedVersion: comp.version,
    fixedVersion: adv.fixed_in,
    active,
    updateRisk: risk,
    majorJump: majorJump(comp.version, adv.fixed_in),
    wpVulnDb: true,
  };
  return {
    finding_fingerprint: makeFingerprint(TOOL, ruleId, targetRef, { path: `${type}/${adv.slug}` }),
    rule_id: ruleId,
    title: `${type === 'core' ? 'WordPress core' : adv.slug} ${comp.version}: ${adv.title}`,
    description: adv.description,
    severity: adv.severity,
    native_severity: adv.severity,
    confidence: 'firm',
    location: { path: `${type}/${adv.slug}` },
    remediation: {
      summary: adv.fixed_in
        ? `Update ${adv.slug} to ${adv.fixed_in} or later`
        : `No fixed version published — remove or replace ${adv.slug}`,
      references: adv.references,
    },
    cve_ids: adv.cve_ids,
    advisory_ids: adv.advisory_ids,
    metadata: meta,
  } satisfies FindingInput;
}

function correlateComponent(
  type: WpComponentType,
  comp: WpInstalledComponent,
  advisories: WpAdvisory[],
  targetRef: string,
): FindingInput[] {
  const matches = advisories.filter((a) => a.type === type && a.slug === comp.slug);
  const out: FindingInput[] = [];
  for (const adv of matches) {
    if (isVulnerable(comp.version, adv.vulnerable_ranges)) {
      out.push(buildFinding(type, comp, adv, targetRef));
    }
  }
  return out;
}

/**
 * Correlate a WordPress inventory against advisory intelligence and emit
 * `FindingInput[]` (the shared S5-D1 schema). A non-vulnerable installed version
 * produces NO finding for that component — the Section-10 validation requirement
 * that a safe version yields no false positive.
 */
export function correlateInventory(inv: WpInventory, advisories: WpAdvisory[], targetRef = 'wp-site'): FindingInput[] {
  const out: FindingInput[] = [];
  if (inv.core) {
    out.push(...correlateComponent('core', { slug: 'core', version: inv.core.version, active: true }, advisories, targetRef));
  }
  for (const p of inv.plugins ?? []) out.push(...correlateComponent('plugin', p, advisories, targetRef));
  for (const t of inv.themes ?? []) out.push(...correlateComponent('theme', t, advisories, targetRef));
  return out;
}

export { TOOL as WP_VULN_INTEL_TOOL, primaryId, compareVersions };
export type { Severity };

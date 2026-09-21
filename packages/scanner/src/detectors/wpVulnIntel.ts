import { readFile } from 'node:fs/promises';
import type { FindingInput } from '@platform/shared';
import type { AdapterContext } from '../types.js';
import { correlateInventory } from '../intel/correlate.js';
import { WP_ADVISORIES } from '../intel/wpAdvisories.fixture.js';
import type { WpAdvisory, WpInventory } from '../intel/types.js';

export const INVENTORY_FILENAME = 'wp-inventory.json';

/**
 * Advisory source. The bundled fixture is the default; a live WPScan API client
 * would override this (when `WPSCAN_API_TOKEN` is configured) — see
 * docs/wp-vuln-intel.md. Kept as a function so the source is swappable without
 * touching the correlation core.
 */
export function getAdvisories(): WpAdvisory[] {
  return WP_ADVISORIES;
}

/**
 * S10-D3 correlation detector (rules kind): reads kevin's S10-D4 WordPress
 * inventory from the workspace, correlates installed core/plugin/theme versions
 * against advisory intelligence, and emits `findingInput[]` with CVE ids,
 * fixed-version remediation, and update-risk metadata.
 */
export async function detectWpVulnIntelligence(
  workspaceDir: string,
  ctx: AdapterContext,
): Promise<FindingInput[]> {
  let raw: string;
  try {
    raw = await readFile(`${workspaceDir}/${INVENTORY_FILENAME}`, 'utf8');
  } catch {
    // No inventory materialized (kevin S10-D4 step absent) — nothing to assess.
    return [];
  }
  const inv = JSON.parse(raw) as WpInventory;
  return correlateInventory(inv, getAdvisories(), ctx.target.ref);
}

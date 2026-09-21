import type { Severity } from '@platform/shared';
import type { VersionRange } from './version.js';

/** A single installed WordPress component as produced by kevin's S10-D4 inventory. */
export interface WpInstalledComponent {
  slug: string;
  version: string;
  /** Whether the component is active on the site (drives update-risk priority). */
  active?: boolean;
}

/** WordPress version inventory — the contract S10-D3 consumes from S10-D4. */
export interface WpInventory {
  core?: { version: string };
  plugins?: WpInstalledComponent[];
  themes?: WpInstalledComponent[];
}

export type WpComponentType = 'core' | 'plugin' | 'theme';

export type UpdateRisk = 'low' | 'medium' | 'high';

/**
 * One advisory record from WPScan / advisory intelligence. The bundled dataset
 * is a curated fixture; when `WPSCAN_API_TOKEN` is configured the live API
 * supersedes it (see docs/wp-vuln-intel.md).
 */
export interface WpAdvisory {
  slug: string;
  type: WpComponentType;
  title: string;
  description?: string;
  severity: Severity;
  cve_ids?: string[];
  advisory_ids?: string[];
  references?: string[];
  /** Vulnerable version ranges; first non-vulnerable version is `fixed_in`. */
  vulnerable_ranges: VersionRange[];
  /** Minimum version that resolves the advisory. */
  fixed_in?: string;
  /** Advisory-supplied update-risk classification. */
  update_risk?: {
    risk: UpdateRisk;
    note?: string;
  };
}

export type WpVulnFindingMeta = {
  componentType: WpComponentType;
  slug: string;
  installedVersion: string;
  fixedVersion?: string;
  active: boolean;
  updateRisk: UpdateRisk;
  majorJump: boolean;
  wpVulnDb: true;
};

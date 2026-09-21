'use client';

import type { FindingDto, Severity } from '@platform/shared';
import { listFindings, DEMO_FINDINGS, type FindingListResponse } from './findings';

/** WP vulnerability metadata emitted by Dwight's S10-D3 correlation engine. */
export interface WpVulnMeta {
  componentType: 'core' | 'plugin' | 'theme';
  slug: string;
  installedVersion: string;
  fixedVersion?: string;
  active: boolean;
  updateRisk: 'low' | 'medium' | 'high';
  majorJump: boolean;
  wpVulnDb: true;
}

export type UpdateRisk = WpVulnMeta['updateRisk'];

export function isWpVuln(f: FindingDto): boolean {
  return (f.metadata as Partial<WpVulnMeta> | null)?.wpVulnDb === true;
}

export function wpMeta(f: FindingDto): WpVulnMeta | null {
  const m = f.metadata as Partial<WpVulnMeta> | null;
  return m && m.wpVulnDb === true ? (m as WpVulnMeta) : null;
}

export interface VulnFilters {
  severity: '' | Severity;
  componentType: '' | 'core' | 'plugin' | 'theme';
  updateRisk: '' | UpdateRisk;
  fixedOnly: boolean;
  search: string;
}

const EMPTY: VulnFilters = {
  severity: '',
  componentType: '',
  updateRisk: '',
  fixedOnly: false,
  search: '',
};

function applyFilters(items: FindingDto[], f: VulnFilters): FindingDto[] {
  const search = f.search.trim().toLowerCase();
  return items.filter((i) => {
    const m = wpMeta(i);
    if (!m) return false;
    if (f.severity && i.severity !== f.severity) return false;
    if (f.componentType && m.componentType !== f.componentType) return false;
    if (f.updateRisk && m.updateRisk !== f.updateRisk) return false;
    if (f.fixedOnly && !m.fixedVersion) return false;
    if (search) {
      const hay = `${i.title} ${i.ruleId ?? ''} ${m.slug} ${(i.cveIds ?? []).join(' ')} ${(i.advisoryIds ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Lists WP vulnerability findings by reusing the shared findings endpoint and
 * filtering to Dwight's S10-D3 records (metadata.wpVulnDb === true). Single
 * page (limit 200) — WP vuln counts per site are bounded; no cursor paging.
 * ponytail: swap for cursor paging if a tenant ever exceeds one page.
 */
export async function listVulnerabilities(f: VulnFilters): Promise<FindingListResponse> {
  const data = await listFindings({ severity: f.severity ? [f.severity] : undefined, limit: 200 });
  return { items: applyFilters(data.items, f), nextCursor: null };
}

export const EMPTY_VULN_FILTERS = EMPTY;

/** Offline review fixtures — only rendered when the findings API is unreachable. */
export const DEMO_VULNS: FindingDto[] = DEMO_FINDINGS.filter(isWpVuln).concat([
  {
    id: 'fnd_wp_demo_01',
    scanRunId: 'run_wpv_1',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-wp-core-6.3.1',
    ruleId: 'wp-vuln-intel.core.wordpress-core.CVE-2023-5568',
    title: 'WordPress core 6.3.1: Object injection in REST API',
    description: 'Authenticated object injection via crafted REST API requests.',
    severity: 'high',
    nativeSeverity: 'HIGH',
    confidence: 'firm',
    scanner: 'wp-vuln-intel',
    scannerVersion: '1.0.0',
    imageDigest: null,
    targetRef: 'wp-site',
    targetBranch: null,
    location: { path: 'core/wordpress-core' },
    evidence: 'Installed core version 6.3.1 matches vulnerable range (< 6.3.2).',
    remediation: { summary: 'Update wordpress-core to 6.3.2 or later', references: ['https://wpvulndb.com/vulnerabilities/1234'] },
    cveIds: ['CVE-2023-5568'],
    advisoryIds: ['WPVULNDB-1234'],
    metadata: { componentType: 'core', slug: 'wordpress-core', installedVersion: '6.3.1', fixedVersion: '6.3.2', active: true, updateRisk: 'high', majorJump: false, wpVulnDb: true },
    rawArtifactPath: null,
    status: 'open',
    assignedTo: null,
    assignedBy: null,
    assignedAt: null,
    remediationStatus: 'not_started',
    resolvedAt: null,
    firstSeenAt: '2026-08-20T10:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-26T09:30:00.000Z',
  },
  {
    id: 'fnd_wp_demo_02',
    scanRunId: 'run_wpv_1',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-wp-plugin-elementor',
    ruleId: 'wp-vuln-intel.plugin.elementor.CVE-2024-0987',
    title: 'Elementor 3.5.0: Authenticated stored XSS',
    description: 'Stored XSS in the Elementor builder allows privilege escalation.',
    severity: 'critical',
    nativeSeverity: 'CRITICAL',
    confidence: 'firm',
    scanner: 'wp-vuln-intel',
    scannerVersion: '1.0.0',
    imageDigest: null,
    targetRef: 'wp-site',
    targetBranch: null,
    location: { path: 'plugin/elementor' },
    evidence: 'Installed plugin elementor 3.5.0 is below fixed version 3.5.4.',
    remediation: { summary: 'Update elementor to 3.5.4 or later' },
    cveIds: ['CVE-2024-0987'],
    advisoryIds: null,
    metadata: { componentType: 'plugin', slug: 'elementor', installedVersion: '3.5.0', fixedVersion: '3.5.4', active: true, updateRisk: 'high', majorJump: false, wpVulnDb: true },
    rawArtifactPath: null,
    status: 'open',
    assignedTo: null,
    assignedBy: null,
    assignedAt: null,
    remediationStatus: 'in_progress',
    resolvedAt: null,
    firstSeenAt: '2026-08-21T11:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-21T11:00:00.000Z',
    updatedAt: '2026-08-26T09:30:00.000Z',
  },
  {
    id: 'fnd_wp_demo_03',
    scanRunId: 'run_wpv_1',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-wp-theme-avada',
    ruleId: 'wp-vuln-intel.theme.avada.ADV-2024-555',
    title: 'Avada 7.5.0: Local file inclusion',
    description: 'LFI in the Avada theme allows reading arbitrary files.',
    severity: 'medium',
    nativeSeverity: 'MEDIUM',
    confidence: 'firm',
    scanner: 'wp-vuln-intel',
    scannerVersion: '1.0.0',
    imageDigest: null,
    targetRef: 'wp-site',
    targetBranch: null,
    location: { path: 'theme/avada' },
    evidence: 'Installed theme avada 7.5.0 is below fixed version 7.6.0 (major jump).',
    remediation: { summary: 'Update avada to 7.6.0 or later' },
    cveIds: null,
    advisoryIds: ['ADV-2024-555'],
    metadata: { componentType: 'theme', slug: 'avada', installedVersion: '7.5.0', fixedVersion: '7.6.0', active: true, updateRisk: 'medium', majorJump: true, wpVulnDb: true },
    rawArtifactPath: null,
    status: 'open',
    assignedTo: null,
    assignedBy: null,
    assignedAt: null,
    remediationStatus: 'not_started',
    resolvedAt: null,
    firstSeenAt: '2026-08-22T07:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-22T07:00:00.000Z',
    updatedAt: '2026-08-26T09:30:00.000Z',
  },
]);

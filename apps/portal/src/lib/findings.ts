'use client';

import type { FindingDto, FindingListQuery, FindingUpdateInput } from '@platform/shared';
import { authFetch } from './auth';

/** Portal-side envelope for the findings list endpoint (mirrors audit's shape). */
export interface FindingListResponse {
  items: FindingDto[];
  nextCursor: string | null;
}

const BASE = '/api/v1/findings';

export async function listFindings(q: FindingListQuery = {}): Promise<FindingListResponse> {
  const p = new URLSearchParams();
  if (q.projectId) p.set('projectId', q.projectId);
  if (q.orgId) p.set('orgId', q.orgId);
  if (q.environmentId) p.set('environmentId', q.environmentId);
  for (const s of q.severity ?? []) p.append('severity', s);
  for (const s of q.status ?? []) p.append('status', s);
  if (q.scanner) p.set('scanner', q.scanner);
  if (q.ruleId) p.set('ruleId', q.ruleId);
  if (q.assignedTo) p.set('assignedTo', q.assignedTo);
  if (q.search?.trim()) p.set('search', q.search.trim());
  if (q.limit) p.set('limit', String(q.limit));
  if (q.cursor) p.set('cursor', q.cursor);
  return authFetch<FindingListResponse>(`${BASE}?${p.toString()}`);
}

/** Single PATCH handles status, remediationStatus and assignment (FindingUpdateInput). */
export async function updateFinding(id: string, body: FindingUpdateInput): Promise<FindingDto> {
  return authFetch<FindingDto>(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Derives a finding's surfacing context from signals already on FindingDto.
 * The normalized model does not tag headless/cross-stack per finding (that
 * lives on the scan-run target kind), so we infer it client-side:
 *   - url:    live-URL scan (location.url_param) or http(s) target ref
 *   - image:  container/artifact scan (imageDigest present)
 *   - host:   host-metadata scan (no git branch)
 *   - repo:   git-backed scan (branch present, no headless signals)
 * Upgrade path: replace with ScanRunDto.target.kind once S6-D1 exposes it.
 */
export type FindingContext = 'repo' | 'url' | 'image' | 'host';

export function findingContext(f: FindingDto): FindingContext {
  const loc = (f.location ?? null) as { url_param?: string } | null;
  if (loc?.url_param) return 'url';
  if (f.imageDigest) return 'image';
  if (f.targetRef?.startsWith('http://') || f.targetRef?.startsWith('https://')) return 'url';
  if (f.targetBranch == null) return 'host';
  return 'repo';
}

export function isHeadlessContext(c: FindingContext): boolean {
  return c !== 'repo';
}

/**
 * Local fixtures so the UI is reviewable before the D1 lifecycle endpoint
 * (`GET /api/v1/findings`) is deployed. Only rendered when the API is
 * unreachable; never presented as real data.
 */
export const DEMO_FINDINGS: FindingDto[] = [
  {
    id: 'fnd_demo_01',
    scanRunId: 'run_8a1c',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-semgrep-sqli-abc123',
    ruleId: 'semgrep.sql-injection',
    title: 'SQL injection via string-concatenated query',
    description: 'User input flows into a SQL query without parameterization.',
    severity: 'critical',
    nativeSeverity: 'ERROR',
    confidence: 'firm',
    scanner: 'semgrep',
    scannerVersion: '1.78.0',
    imageDigest: 'sha256:aa',
    targetRef: 'org/payments',
    targetBranch: 'main',
    location: { path: 'src/api/orders.ts', start_line: 42, end_line: 44 },
    evidence: "const q = `SELECT * FROM orders WHERE id = ${req.params.id}`;",
    remediation: {
      summary: 'Use a parameterized query or an ORM prepared statement.',
      references: ['https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html'],
    },
    cveIds: null,
    advisoryIds: null,
    metadata: { tool: 'semgrep', policy: 'pci-dss' },
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
    id: 'fnd_demo_02',
    scanRunId: 'run_3f2b',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-gitleaks-aws-xyz',
    ruleId: 'Gitleaks.aws-access-token',
    title: 'Hard-coded AWS access key',
    description: 'A long-lived AWS credential is committed to source.',
    severity: 'high',
    nativeSeverity: 'HIGH',
    confidence: 'certain',
    scanner: 'gitleaks',
    scannerVersion: '8.18.0',
    imageDigest: 'sha256:bb',
    targetRef: 'org/payments',
    targetBranch: 'main',
    location: { path: 'config/secrets.ts', start_line: 7, end_line: 7 },
    evidence: 'const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";',
    remediation: { summary: 'Rotate the key and move it to a secrets manager.' },
    cveIds: null,
    advisoryIds: null,
    metadata: null,
    rawArtifactPath: null,
    status: 'in_progress',
    assignedTo: '22222222-2222-2222-2222-222222222222',
    assignedBy: '33333333-3333-3333-3333-333333333333',
    assignedAt: '2026-08-25T12:00:00.000Z',
    remediationStatus: 'in_progress',
    resolvedAt: null,
    firstSeenAt: '2026-08-19T08:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-19T08:00:00.000Z',
    updatedAt: '2026-08-25T12:00:00.000Z',
  },
  {
    id: 'fnd_demo_03',
    scanRunId: 'run_9c4d',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-trivy-cve-nginx',
    ruleId: 'CVE-2024-1234',
    title: 'Vulnerable nginx base image',
    description: 'Base image ships a known-vulnerable nginx version.',
    severity: 'medium',
    nativeSeverity: 'MEDIUM',
    confidence: 'firm',
    scanner: 'trivy',
    scannerVersion: '0.55.0',
    imageDigest: 'sha256:cc',
    targetRef: 'org/payments',
    targetBranch: null,
    location: { path: 'Dockerfile', start_line: 1, end_line: 1 },
    evidence: 'FROM nginx:1.25.3',
    remediation: { summary: 'Upgrade to nginx:1.27.1 or later.' },
    cveIds: ['CVE-2024-1234'],
    advisoryIds: null,
    metadata: { pkg: 'nginx' },
    rawArtifactPath: null,
    status: 'open',
    assignedTo: null,
    assignedBy: null,
    assignedAt: null,
    remediationStatus: 'not_started',
    resolvedAt: null,
    firstSeenAt: '2026-08-21T11:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-21T11:00:00.000Z',
    updatedAt: '2026-08-26T09:30:00.000Z',
  },
  {
    id: 'fnd_demo_04',
    scanRunId: 'run_1e7f',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-zap-xss-form',
    ruleId: 'ZAP.XSS.001',
    title: 'Reflected XSS in search form',
    description: 'Search parameter is reflected without encoding.',
    severity: 'high',
    nativeSeverity: 'Medium',
    confidence: 'tentative',
    scanner: 'zap',
    scannerVersion: '2.16.0',
    imageDigest: null,
    targetRef: 'https://shop.example.com',
    targetBranch: null,
    location: { url_param: '/search?q=' },
    evidence: '<script>alert(1)</script> reflected in response body.',
    remediation: { summary: 'Context-encode output and set a restrictive CSP.' },
    cveIds: null,
    advisoryIds: null,
    metadata: null,
    rawArtifactPath: null,
    status: 'false_positive',
    assignedTo: '22222222-2222-2222-2222-222222222222',
    assignedBy: '33333333-3333-3333-3333-333333333333',
    assignedAt: '2026-08-24T10:00:00.000Z',
    remediationStatus: 'wont_fix',
    resolvedAt: null,
    firstSeenAt: '2026-08-18T09:00:00.000Z',
    lastSeenAt: '2026-08-26T09:30:00.000Z',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-26T09:30:00.000Z',
  },
  {
    id: 'fnd_demo_05',
    scanRunId: 'run_5a2c',
    projectId: '11111111-1111-1111-1111-111111111111',
    environmentId: null,
    fingerprint: 'fp-lynis-perm-etc',
    ruleId: 'lynis.file-permissions',
    title: 'World-writable configuration file',
    description: 'A config file is writable by all users.',
    severity: 'low',
    nativeSeverity: 'low',
    confidence: 'firm',
    scanner: 'lynis',
    scannerVersion: '3.1.0',
    imageDigest: 'sha256:dd',
    targetRef: 'org/payments',
    targetBranch: null,
    location: { path: '/etc/app/conf.d/10-tuning', start_line: 0, end_line: 0 },
    evidence: 'perms: 0666 owner: root',
    remediation: { summary: 'Tighten permissions to 0640.' },
    cveIds: null,
    advisoryIds: null,
    metadata: null,
    rawArtifactPath: null,
    status: 'resolved',
    assignedTo: null,
    assignedBy: null,
    assignedAt: null,
    remediationStatus: 'done',
    resolvedAt: '2026-08-23T15:00:00.000Z',
    firstSeenAt: '2026-08-17T07:00:00.000Z',
    lastSeenAt: '2026-08-23T15:00:00.000Z',
    createdAt: '2026-08-17T07:00:00.000Z',
    updatedAt: '2026-08-23T15:00:00.000Z',
  },
];

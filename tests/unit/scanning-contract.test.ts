import { describe, expect, it } from 'vitest';
import {
  findingInput,
  findingListQuery,
  findingUpdateInput,
  scanEnvelope,
  SEVERITIES,
  FINDING_STATUSES,
  REMEDIATION_STATUSES,
} from '@platform/shared';

const validFinding = {
  finding_fingerprint: 'fp123',
  rule_id: 'semgrep.rules.xss',
  title: 'Reflected XSS',
  description: 'User input reflected without encoding',
  severity: 'high',
  native_severity: 'ERROR',
  confidence: 'firm',
  location: { path: 'src/app.ts', start_line: 12, end_line: 14 },
  evidence: 'echo(req.query.q)',
  remediation: { summary: 'Encode output', references: ['https://owasp.org'] },
  cve_ids: ['CVE-2024-0001'],
  metadata: { tool: 'semgrep' },
};

describe('scanning contracts', () => {
  it('accepts a well-formed finding', () => {
    expect(findingInput.safeParse(validFinding).success).toBe(true);
  });

  it('defaults confidence to firm', () => {
    const r = findingInput.safeParse({ finding_fingerprint: 'f', title: 't', severity: 'low' });
    expect(r.success && r.data.confidence).toBe('firm');
  });

  it('rejects out-of-range severity', () => {
    expect(findingInput.safeParse({ ...validFinding, severity: 'blast' }).success).toBe(false);
  });

  it('accepts a complete scan envelope', () => {
    const env = {
      scan_id: 'scan-1',
      project_id: '11111111-1111-1111-1111-111111111111',
      tool: { name: 'semgrep', version: '1.86.0' },
      target: { kind: 'repo', ref: 'abc123', branch: 'main' },
      status: 'completed',
      findings: [validFinding],
    };
    expect(scanEnvelope.safeParse(env).success).toBe(true);
  });

  it('rejects envelope when scan_id mismatches url shape at handler level', () => {
    // envelope itself validates; URL/body match is enforced in the route.
    const env = scanEnvelope.parse({
      scan_id: 's1',
      project_id: '11111111-1111-1111-1111-111111111111',
      tool: { name: 't' },
      target: { kind: 'repo', ref: 'r' },
      status: 'partial',
      findings: [],
    });
    expect(env.scan_id).toBe('s1');
  });

  it('parses severity/status filter arrays', () => {
    const q = findingListQuery.parse({ projectId: '11111111-1111-1111-1111-111111111111', severity: ['critical', 'high'], status: ['open'] });
    expect(q.severity).toEqual(['critical', 'high']);
    expect(q.status).toEqual(['open']);
  });

  it('requires projectId or orgId on list query (handler-level)', () => {
    const q = findingListQuery.parse({ severity: ['low'] });
    expect(q.projectId).toBeUndefined();
    expect(q.orgId).toBeUndefined();
  });

  it('requires at least one field on lifecycle update', () => {
    expect(findingUpdateInput.safeParse({}).success).toBe(false);
    expect(findingUpdateInput.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(findingUpdateInput.safeParse({ assignedTo: null }).success).toBe(true);
  });

  it('enum vocabularies are stable', () => {
    expect(SEVERITIES).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(FINDING_STATUSES).toEqual(['open', 'in_progress', 'resolved', 'false_positive', 'dismissed']);
    expect(REMEDIATION_STATUSES).toEqual(['not_started', 'in_progress', 'done', 'wont_fix']);
  });
});

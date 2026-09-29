'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react';
import type { FindingDto, FindingStatus } from '@platform/shared';
import { FINDING_STATUSES } from '@/lib/enums';
import { apiFetch } from '../../../../lib/api';
import { errMsg, useApi } from '../../../../lib/useApi';
import { Badge, PageHeader, Panel, RevealGroup, RevealItem, Segmented, Skeleton, useToast } from '../../../../components/ui';
import { SEVERITY_TONE } from '../../../../lib/tones';

function remediationSummary(remediation: unknown): string | null {
  if (remediation && typeof remediation === 'object' && 'summary' in remediation) {
    const s = (remediation as { summary?: unknown }).summary;
    return typeof s === 'string' ? s : null;
  }
  return null;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export default function FindingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data: finding, error, setData } = useApi<FindingDto>(`/findings/${id}`);
  const [saving, setSaving] = useState(false);

  async function updateStatus(status: FindingStatus) {
    setSaving(true);
    try {
      setData(await apiFetch<FindingDto>(`/findings/${id}`, { method: 'PATCH', body: { status } }));
      toast.success(`Marked as ${status.replace('_', ' ')}.`);
    } catch (e) {
      toast.error(errMsg(e, 'Could not update the finding.'));
    } finally {
      setSaving(false);
    }
  }

  const back = (
    <Link href="/findings" className="mb-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-dim outline-none transition-colors hover:text-ink focus-visible:text-ink">
      <ArrowLeft size={16} />
      All findings
    </Link>
  );

  if (error) return <div>{back}<p className="text-sm text-critical">{error}</p></div>;
  if (!finding) {
    return (
      <div>
        {back}
        <Skeleton className="mb-3 h-8 w-2/3" />
        <Skeleton className="mb-8 h-4 w-1/3" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const fix = remediationSummary(finding.remediation);
  const loc = finding.location as { path?: string; start_line?: number } | null;

  return (
    <div>
      {back}
      <PageHeader title={finding.title} description={[finding.scanner, finding.ruleId].filter(Boolean).join(' · ')} actions={<Badge tone={SEVERITY_TONE[finding.severity]} dot className="capitalize">{finding.severity}</Badge>} />
      <RevealGroup className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex flex-col gap-4">
          {finding.description && (
            <RevealItem>
              <Panel>
                <h2 className="mb-2 text-[13px] font-medium text-ink-dim">What was found</h2>
                <p className="max-w-[68ch] text-sm leading-7 text-ink">{finding.description}</p>
              </Panel>
            </RevealItem>
          )}
          {fix && (
            <RevealItem>
              <Panel>
                <h2 className="mb-2 text-[13px] font-medium text-ink-dim">How to fix it</h2>
                <p className="max-w-[68ch] text-sm leading-7 text-ink">{fix}</p>
              </Panel>
            </RevealItem>
          )}
          <RevealItem>
            <Panel>
              <h2 className="mb-3 text-[13px] font-medium text-ink-dim">Status</h2>
              <Segmented label="Finding status" value={finding.status} onChange={(s) => !saving && updateStatus(s)} options={FINDING_STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))} />
            </Panel>
          </RevealItem>
        </div>
        <RevealItem>
          <Panel>
            <dl className="flex flex-col gap-4">
              <Meta label="Scanner">{finding.scanner}</Meta>
              <Meta label="Rule">{finding.ruleId ?? 'None'}</Meta>
              {loc?.path && (
                <Meta label="Location">
                  <span className="font-mono text-[13px]">
                    {loc.path}
                    {loc.start_line ? `:${loc.start_line}` : ''}
                  </span>
                </Meta>
              )}
              <Meta label="Confidence">
                <span className="capitalize">{finding.confidence}</span>
              </Meta>
            </dl>
          </Panel>
        </RevealItem>
      </RevealGroup>
    </div>
  );
}

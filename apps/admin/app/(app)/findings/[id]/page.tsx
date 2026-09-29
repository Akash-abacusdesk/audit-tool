'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { FindingDto, FindingStatus } from '@platform/shared';
import { FINDING_STATUSES } from '@/lib/enums';
import { apiFetch, ApiRequestError } from '../../../../lib/api';

function remediationSummary(remediation: unknown): string | null {
  if (remediation && typeof remediation === 'object' && 'summary' in remediation) {
    const s = (remediation as { summary?: unknown }).summary;
    return typeof s === 'string' ? s : null;
  }
  return null;
}

export default function FindingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [finding, setFinding] = useState<FindingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<FindingDto>(`/findings/${id}`)
      .then(setFinding)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load finding'));
  }, [id]);

  async function updateStatus(status: FindingStatus) {
    setSaving(true);
    try {
      const updated = await apiFetch<FindingDto>(`/findings/${id}`, { method: 'PATCH', body: { status } });
      setFinding(updated);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'update failed');
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>;
  if (!finding) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="skeleton h-6 w-2/3" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <Link href="/findings" className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]">
        ← Back to findings
      </Link>

      <h1 className="mb-1.5 text-xl font-semibold tracking-tight">{finding.title}</h1>
      <p className="mb-5 text-sm text-[var(--color-text-dim)]">
        {finding.scanner} <span className="text-[var(--color-text-faint)]">·</span> {finding.severity}{' '}
        <span className="text-[var(--color-text-faint)]">·</span> {finding.ruleId ?? 'no rule id'}
      </p>

      {finding.description && <p className="surface mb-4 p-4 text-sm leading-relaxed">{finding.description}</p>}

      <div className="surface mb-4 p-4">
        <div className="label mb-2.5">Status</div>
        <div className="flex flex-wrap gap-2">
          {FINDING_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => updateStatus(s)}
              disabled={saving || finding.status === s}
              className={finding.status === s ? 'btn-primary' : 'btn-ghost'}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {remediationSummary(finding.remediation) && (
        <div className="surface p-4">
          <div className="label mb-2.5">Remediation</div>
          <p className="text-sm leading-relaxed">{remediationSummary(finding.remediation)}</p>
        </div>
      )}
    </div>
  );
}

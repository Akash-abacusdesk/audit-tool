'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import * as motion from 'motion/react-m';
import type { FindingDto, Page, Severity } from '@platform/shared';
import { SEVERITIES } from '@/lib/enums';
import { apiFetch } from '../../../lib/api';
import { useMeContext } from '../../../lib/MeContext';
import { PageHeader } from '../../../components/PageHeader';
import { SkeletonRows } from '../../../components/Skeleton';

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: 'badge-critical',
  high: 'badge-high',
  medium: 'badge-medium',
  low: 'badge-low',
  info: 'badge-info',
};

export default function FindingsPage() {
  const me = useMeContext();
  const orgId = me.bindings[0]?.orgId;
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [items, setItems] = useState<FindingDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    setItems(null);
    const q = new URLSearchParams({ orgId });
    if (severity !== 'all') q.set('severity', severity);
    apiFetch<Page<FindingDto>>(`/findings?${q.toString()}`)
      .then((page) => setItems(page.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load findings'));
  }, [orgId, severity]);

  return (
    <div>
      <PageHeader title="Findings" subtitle="Every security finding across your projects, ranked by severity." />

      <div className="mb-5 flex flex-wrap gap-2">
        <button onClick={() => setSeverity('all')} className={severity === 'all' ? 'btn-primary' : 'btn-ghost'}>
          All
        </button>
        {SEVERITIES.map((s) => (
          <button key={s} onClick={() => setSeverity(s)} className={severity === s ? 'btn-primary' : 'btn-ghost'}>
            <span className={`dot ${severity === s ? 'text-white' : ''}`} style={severity !== s ? { color: `var(--color-${s})` } : undefined} />
            {s}
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
      {!error && items === null && <SkeletonRows />}
      {items !== null && items.length === 0 && (
        <div className="surface flex flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-sm font-medium">No findings</p>
          <p className="text-sm text-[var(--color-text-dim)]">Nothing matches this filter yet.</p>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
          {items.map((f, i) => (
            <motion.div
              key={f.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.025, 0.3), duration: 0.2 }}
            >
              <Link href={`/findings/${f.id}`} className="row-hover flex items-center gap-3 px-4 py-3.5">
                <span className={SEVERITY_BADGE[f.severity]}>
                  <span className="dot" />
                  {f.severity}
                </span>
                <span className="flex-1 truncate text-sm">{f.title}</span>
                <span className="text-xs text-[var(--color-text-faint)]">{f.scanner}</span>
                <span className="badge-neutral">{f.status.replace('_', ' ')}</span>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

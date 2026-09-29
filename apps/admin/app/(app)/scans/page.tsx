'use client';

import { useEffect, useState } from 'react';
import * as motion from 'motion/react-m';
import type { Page, ScanRunDto } from '@platform/shared';
import { apiFetch } from '../../../lib/api';
import { useMeContext } from '../../../lib/MeContext';
import { PageHeader } from '../../../components/PageHeader';
import { SkeletonRows } from '../../../components/Skeleton';

const STATUS_BADGE: Record<ScanRunDto['status'], string> = {
  completed: 'badge-low',
  partial: 'badge-medium',
  failed: 'badge-critical',
};

export default function ScansPage() {
  const me = useMeContext();
  const orgId = me.bindings[0]?.orgId;
  const [items, setItems] = useState<ScanRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    apiFetch<Page<ScanRunDto>>(`/scans?orgId=${orgId}`)
      .then((page) => setItems(page.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load scans'));
  }, [orgId]);

  return (
    <div>
      <PageHeader title="Scan Runs" subtitle="Every scanner execution, with its finding counts." />

      {error && <p className="rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
      {!error && items === null && <SkeletonRows />}
      {items !== null && items.length === 0 && (
        <div className="surface flex flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-sm font-medium">No scan runs</p>
          <p className="text-sm text-[var(--color-text-dim)]">Nothing has been scanned yet.</p>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
          {items.map((r, i) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.025, 0.3), duration: 0.2 }}
              className="row-hover flex items-center gap-3 px-4 py-3.5"
            >
              <span className={STATUS_BADGE[r.status]}>
                <span className="dot" />
                {r.status}
              </span>
              <span className="flex-1 truncate text-sm">
                {r.tool.name} <span className="text-[var(--color-text-faint)]">·</span> {r.target.ref ?? 'unknown target'}
              </span>
              <span className="text-xs text-[var(--color-text-faint)]">
                {r.findingCounts.critical} critical / {r.findingCounts.total} total
              </span>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import * as motion from 'motion/react-m';
import { Binoculars } from '@phosphor-icons/react';
import type { Page, ScanRunDto } from '@platform/shared';
import { useMeContext } from '../../../lib/MeContext';
import { useApi } from '../../../lib/useApi';
import { Badge, EmptyState, PageHeader, Panel, SkeletonRows, rise, stagger, type Tone } from '../../../components/ui';

const STATUS: Record<ScanRunDto['status'], { label: string; tone: Tone }> = {
  completed: { label: 'Completed', tone: 'accent' },
  partial: { label: 'Incomplete', tone: 'medium' },
  failed: { label: 'Failed', tone: 'critical' },
};

export default function ScansPage() {
  const me = useMeContext();
  const orgId = me.bindings[0]?.orgId;
  const scans = useApi<Page<ScanRunDto>>(orgId ? `/scans?orgId=${orgId}&limit=100` : null);
  const items = scans.data?.items ?? null;

  return (
    <div>
      <PageHeader title="Scans" description="Every scanner run and how many findings it produced." />
      <Panel flush>
        {scans.error && <p className="p-5 text-sm text-critical">{scans.error}</p>}
        {!scans.error && items === null && <SkeletonRows count={6} />}
        {items?.length === 0 && (
          <EmptyState icon={<Binoculars size={20} />} title="No scans yet">
            Results show up here as soon as a scanner reports for one of your sites.
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <motion.ul variants={stagger(0.03)} initial="hidden" animate="show" className="divide-y divide-line">
            {items.map((r) => {
              const s = STATUS[r.status];
              return (
                <motion.li key={r.id} variants={rise} className="flex items-center gap-4 px-5 py-3.5 transition-colors duration-200 hover:bg-white/[0.035]">
                  <Badge tone={s.tone} dot className="w-24 justify-center">
                    {s.label}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.tool.name}</div>
                    <div className="truncate font-mono text-xs text-ink-faint">{r.target.ref ?? 'unknown target'}</div>
                  </div>
                  <div className="text-right text-xs text-ink-faint">
                    <span className={r.findingCounts.critical ? 'tabular-nums text-critical' : 'tabular-nums'}>{r.findingCounts.critical}</span> critical
                    <span className="mx-1.5">/</span>
                    <span className="tabular-nums text-ink-dim">{r.findingCounts.total}</span> total
                  </div>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </Panel>
    </div>
  );
}

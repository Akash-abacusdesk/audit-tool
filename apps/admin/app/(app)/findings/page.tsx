'use client';

import { useState } from 'react';
import Link from 'next/link';
import * as motion from 'motion/react-m';
import { CaretRight, CheckCircle } from '@phosphor-icons/react';
import type { FindingDto, Page, Severity } from '@platform/shared';
import { SEVERITIES } from '@/lib/enums';
import { SEVERITY_TONE } from '../../../lib/tones';
import { useMeContext } from '../../../lib/MeContext';
import { useApi } from '../../../lib/useApi';
import { Badge, EmptyState, PageHeader, Panel, Segmented, SkeletonRows, rise, stagger } from '../../../components/ui';

const SEV_DOT: Record<Severity, string> = { critical: 'text-critical', high: 'text-high', medium: 'text-medium', low: 'text-low', info: 'text-info' };

export default function FindingsPage() {
  const me = useMeContext();
  const orgId = me.bindings[0]?.orgId;
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const query = orgId ? `/findings?${new URLSearchParams({ orgId, limit: '100', ...(severity !== 'all' ? { severity } : {}) }).toString()}` : null;
  const findings = useApi<Page<FindingDto>>(query);
  const items = findings.data?.items ?? null;

  return (
    <div>
      <PageHeader
        title="Findings"
        description="Every security finding across your sites, most severe first."
        actions={<Segmented label="Filter by severity" value={severity} onChange={setSeverity} options={[{ value: 'all', label: 'All' }, ...SEVERITIES.map((s) => ({ value: s, label: s, dot: SEV_DOT[s] }))]} />}
      />
      <Panel flush>
        {findings.error && <p className="p-5 text-sm text-critical">{findings.error}</p>}
        {!findings.error && items === null && <SkeletonRows count={8} />}
        {items?.length === 0 && (
          <EmptyState icon={<CheckCircle size={20} />} title="No findings here">
            {severity === 'all' ? 'Nothing has been reported yet.' : `No ${severity} findings are open.`}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <motion.ul key={severity} variants={stagger(0.025)} initial="hidden" animate="show" className="divide-y divide-line">
            {items.map((f) => (
              <motion.li key={f.id} variants={rise}>
                <Link href={`/findings/${f.id}`} className="group flex items-center gap-4 px-5 py-3.5 outline-none transition-colors duration-200 hover:bg-white/[0.035] focus-visible:bg-white/[0.05]">
                  <Badge tone={SEVERITY_TONE[f.severity]} dot className="w-[4.75rem] justify-center capitalize">
                    {f.severity}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{f.title}</div>
                    <div className="truncate font-mono text-xs text-ink-faint">
                      {f.scanner}
                      {f.ruleId ? ` · ${f.ruleId}` : ''}
                    </div>
                  </div>
                  <Badge className="hidden capitalize sm:inline-flex">{f.status.replace('_', ' ')}</Badge>
                  <CaretRight size={16} className="text-ink-faint transition-transform duration-200 ease-spring group-hover:translate-x-0.5 group-hover:text-ink-dim" />
                </Link>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </Panel>
    </div>
  );
}

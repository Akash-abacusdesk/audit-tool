'use client';

import { useEffect, useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { ArrowClockwise, ListChecks, PlugsConnected } from '@phosphor-icons/react';
import type { TaskDto } from '@platform/shared';
import { apiFetch } from '../../../lib/api';
import { useOverview } from '../../../lib/OverviewContext';
import { errMsg, useApi } from '../../../lib/useApi';
import { Badge, Button, EmptyState, PageHeader, Panel, Segmented, SkeletonRows, spring, useToast, type Tone } from '../../../components/ui';

type Filter = 'all' | TaskDto['status'];
const STATUS: Record<TaskDto['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Queued', tone: 'medium' },
  sent: { label: 'In task portal', tone: 'accent' },
  failed: { label: 'Delivery failed', tone: 'critical' },
};

export default function TasksPage() {
  const toast = useToast();
  const { refresh: refreshOverview } = useOverview();
  const tasks = useApi<{ portalConfigured: boolean; items: TaskDto[] }>('/tasks');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);

  // Delivery happens in the background: keep the list fresh without asking the admin to reload.
  const { reload } = tasks;
  useEffect(() => {
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  const items = tasks.data?.items ?? [];
  const count = (s: TaskDto['status']) => items.filter((t) => t.status === s).length;
  const shown = filter === 'all' ? items : items.filter((t) => t.status === filter);

  async function retry(id: string) {
    setBusy(id);
    try {
      await apiFetch(`/tasks/${id}/retry`, { method: 'POST', body: {} });
      toast.success('Queued for another attempt.');
      await Promise.all([tasks.reload(), refreshOverview()]);
    } catch (e) {
      toast.error(errMsg(e, 'Could not retry the task.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Tasks" description="When a scan fails, a task is created for the person who runs that site. Each one is sent to the task portal and tracked here." actions={<Segmented label="Filter tasks" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: items.length }, { value: 'pending', label: 'Queued', count: count('pending') }, { value: 'sent', label: 'Delivered', count: count('sent') }, { value: 'failed', label: 'Failed', count: count('failed') }]} />} />

      {tasks.data && !tasks.data.portalConfigured && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mb-5 flex items-start gap-3 rounded-xl bg-medium/[0.07] p-4 ring-1 ring-inset ring-medium/20">
          <PlugsConnected size={20} className="mt-0.5 shrink-0 text-medium" />
          <div className="text-sm leading-6">
            <p className="font-medium text-ink">The task portal is not connected yet.</p>
            <p className="text-ink-dim">Tasks are safely queued here and go out automatically once the portal is connected (set TASKPORTAL_BASE_URL and TASKPORTAL_API_TOKEN).</p>
          </div>
        </motion.div>
      )}

      <Panel flush>
        {tasks.error && <p className="p-5 text-sm text-critical">{tasks.error}</p>}
        {!tasks.error && tasks.data === null && <SkeletonRows count={4} />}
        {tasks.data && shown.length === 0 && (
          <EmptyState icon={<ListChecks size={20} />} title={filter === 'all' ? 'No tasks yet' : 'Nothing here'}>
            {filter === 'all' ? 'A task appears here whenever a scan fails on one of your sites.' : 'No tasks match this filter.'}
          </EmptyState>
        )}
        <ul className="divide-y divide-line">
          <AnimatePresence initial={false}>
            {shown.map((t) => (
              <motion.li key={t.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t.title}</div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      {t.siteName ?? 'Unknown site'}, {t.assignee ? `assigned to ${t.assignee.displayName}` : 'unassigned'}, {new Date(t.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      {t.externalId && <span className="font-mono"> · #{t.externalId}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS[t.status].tone} dot>
                      {STATUS[t.status].label}
                    </Badge>
                    {t.status !== 'sent' && tasks.data?.portalConfigured && (
                      <Button size="sm" variant="ghost" icon={<ArrowClockwise size={16} />} loading={busy === t.id} onClick={() => retry(t.id)}>
                        Retry
                      </Button>
                    )}
                  </div>
                </div>
                {t.lastError && (
                  <p className="mt-2 rounded-lg bg-critical/[0.06] px-3 py-2 font-mono text-xs leading-5 text-critical/90">
                    {t.lastError} (attempt {t.attempts})
                  </p>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </Panel>
    </div>
  );
}

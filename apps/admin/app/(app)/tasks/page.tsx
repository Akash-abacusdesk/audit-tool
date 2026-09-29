'use client';

import { useEffect, useState } from 'react';
import type { TaskDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { PageHeader } from '../../../components/PageHeader';

const STATUS: Record<TaskDto['status'], { label: string; badge: string }> = {
  pending: { label: 'queued', badge: 'badge-medium' },
  sent: { label: 'in task portal', badge: 'badge-low' },
  failed: { label: 'delivery failed', badge: 'badge-critical' },
};

export default function TasksPage() {
  const [data, setData] = useState<{ portalConfigured: boolean; items: TaskDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setData(await apiFetch('/tasks'));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'failed to load tasks');
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, []);

  async function retry(id: string) {
    setError(null);
    try {
      await apiFetch(`/tasks/${id}/retry`, { method: 'POST', body: {} });
      await refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'retry failed');
    }
  }

  return (
    <div>
      <PageHeader title="Tasks" subtitle="Tasks registered for the team member on a site when one of its scans fails." />
      <div className="max-w-4xl">
        {data && !data.portalConfigured && (
          <p className="mb-4 rounded-lg bg-[var(--color-medium)]/10 px-3 py-2 text-sm text-[var(--color-medium)]">
            The task portal isn&apos;t connected yet. Tasks are kept here and will be sent automatically once it is (set TASKPORTAL_BASE_URL and TASKPORTAL_API_TOKEN).
          </p>
        )}
        {error && <p className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
        <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
          {data === null && <p className="p-4 text-sm text-[var(--color-text-dim)]">Loading…</p>}
          {data?.items.length === 0 && <p className="p-4 text-sm text-[var(--color-text-dim)]">No tasks yet. They appear here when a scan fails.</p>}
          {data?.items.map((t) => (
            <div key={t.id} className="row-hover px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.title}</span>
                <span className={STATUS[t.status].badge}>{STATUS[t.status].label}</span>
              </div>
              <div className="text-xs text-[var(--color-text-dim)]">
                {t.siteName ?? 'unknown site'} · {t.assignee ? `assigned to ${t.assignee.displayName}` : 'unassigned'} · {new Date(t.createdAt).toLocaleString()}
                {t.externalId && ` · portal id ${t.externalId}`}
              </div>
              {t.lastError && <div className="mt-1 text-xs text-[var(--color-critical)]">Last error: {t.lastError} (attempt {t.attempts})</div>}
              {t.status !== 'sent' && data.portalConfigured && (
                <button className="btn-ghost mt-2 !px-3 !py-1.5 text-xs" onClick={() => retry(t.id)}>Retry now</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

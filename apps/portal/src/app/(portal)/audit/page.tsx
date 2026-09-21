'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { AuditEventDto } from '@platform/shared';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader, AccessDenied, ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { fmtDateTime, shortId } from '@/lib/format';

const RESULT_CLASS = {
  allow: 'bg-success/10 text-success ring-success/25',
  deny: 'bg-destructive/10 text-destructive ring-destructive/25',
  error: 'bg-severity-high/10 text-severity-high ring-severity-high/25',
} as const;

interface Filters {
  result: '' | AuditEventDto['result'];
  action: string;
  actorId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { result: '', action: '', actorId: '', from: '', to: '' };

export default function AuditPage() {
  const { me } = useSession();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState<{ items: AuditEventDto[]; nextCursor: string | null }>({ items: [], nextCursor: null });
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: Filters, cursor?: string) => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ limit: '50' });
    if (cursor) q.set('cursor', cursor);
    if (f.result) q.set('result', f.result);
    if (f.action.trim()) q.set('action', f.action.trim());
    if (f.actorId.trim()) q.set('actorId', f.actorId.trim());
    if (f.from) q.set('from', new Date(f.from).toISOString());
    if (f.to) q.set('to', new Date(f.to).toISOString());
    try {
      const data = await authFetch<{ items: AuditEventDto[]; nextCursor: string | null }>(
        `/api/v1/audit-events?${q.toString()}`
      );
      setPage((prev) =>
        cursor ? { items: [...prev.items, ...data.items], nextCursor: data.nextCursor } : data
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load audit events');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(EMPTY_FILTERS);
  }, [load]);

  if (!me) return null;
  if (!canAnywhere(me, 'audit.read')) return <AccessDenied permission="audit.read" />;

  return (
    <>
      <Topbar trail={['Audit Log']} />
      <main className="flex-1 space-y-5 overflow-y-auto p-6">
        <PageHeader
          title="Audit Log"
          description="Every permission-checked action — grants, denials and errors — newest first."
        />

        <form
          className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card p-4 shadow-xs sm:grid-cols-3 lg:grid-cols-6 lg:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void load(filters);
          }}
        >
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Result</span>
            <select
              value={filters.result}
              onChange={(e) => setFilters({ ...filters, result: e.target.value as Filters['result'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
              <option value="error">error</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Action</span>
            <Input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="role.grant" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Actor ID</span>
            <Input value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })} placeholder="uuid" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">From</span>
            <Input type="datetime-local" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">To</span>
            <Input type="datetime-local" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              Apply
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                void load(EMPTY_FILTERS);
              }}
            >
              Reset
            </Button>
          </div>
        </form>

        <Table>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>Result</Th>
              <Th>Scope</Th>
              <Th>Resource</Th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((ev) => (
              <Fragment key={ev.id}>
                <Tr onClick={() => setOpenId(openId === ev.id ? null : ev.id)} className="cursor-pointer">
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(ev.createdAt)}</Td>
                  <Td className="font-mono text-xs">{ev.action}</Td>
                  <Td>
                    <Badge dot className={RESULT_CLASS[ev.result]}>
                      {ev.result}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {shortId(ev.orgId)}
                    {ev.projectId ? ` · ${shortId(ev.projectId)}` : ''}
                    {ev.environmentId ? ` · ${shortId(ev.environmentId)}` : ''}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{ev.resource ?? '—'}</Td>
                </Tr>
                {openId === ev.id ? (
                  <Tr>
                    <Td colSpan={5} className="bg-muted/30">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                        <dt className="text-muted-foreground">actorId</dt>
                        <dd>{ev.actorId ?? 'null'}</dd>
                        <dt className="text-muted-foreground">requestId</dt>
                        <dd>{ev.requestId ?? '—'}</dd>
                        <dt className="text-muted-foreground">details</dt>
                        <dd className="break-all">{JSON.stringify(ev.details)}</dd>
                      </dl>
                    </Td>
                  </Tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>

        {!loading && page.items.length === 0 && !error ? (
          <p className="rounded-xl border border-dashed border-border bg-card/50 px-8 py-10 text-center text-sm text-muted-foreground">
            No audit events match these filters.
          </p>
        ) : null}
        {page.nextCursor ? (
          <Button variant="outline" onClick={() => void load(filters, page.nextCursor!)}>
            Load more
          </Button>
        ) : null}
        {error ? <ErrorState code="AUDIT" message={error} /> : null}
      </main>
    </>
  );
}

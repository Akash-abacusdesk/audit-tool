'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FindingDto, FindingStatus, RemediationStatus } from '@platform/shared';
import { FINDING_STATUSES, REMEDIATION_STATUSES, SEVERITIES } from '@platform/shared';
import type { Severity } from '@/lib/severity';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader, AccessDenied, ErrorState } from '@/components/ui/states';
import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { fmtDateTime, shortId } from '@/lib/format';
import {
  listFindings,
  updateFinding,
  DEMO_FINDINGS,
  findingContext,
  isHeadlessContext,
  type FindingContext,
  type FindingListResponse,
} from '@/lib/findings';

interface Filters {
  severity: '' | Severity;
  status: '' | FindingStatus;
  remediationStatus: '' | RemediationStatus;
  scanner: string;
  context: '' | 'repo' | 'headless';
  search: string;
}

const EMPTY_FILTERS: Filters = {
  severity: '',
  status: '',
  remediationStatus: '',
  scanner: '',
  context: '',
  search: '',
};

const CONTEXT_CLASS: Record<FindingContext, string> = {
  repo: 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/25',
  url: 'bg-violet-500/10 text-violet-600 ring-violet-500/25',
  image: 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/25',
  host: 'bg-teal-500/10 text-teal-600 ring-teal-500/25',
};

const STATUS_CLASS: Record<FindingStatus, string> = {
  open: 'bg-severity-high/10 text-severity-high ring-severity-high/25',
  in_progress: 'bg-amber-500/10 text-amber-600 ring-amber-500/25',
  resolved: 'bg-success/10 text-success ring-success/25',
  false_positive: 'bg-sky-500/10 text-sky-600 ring-sky-500/25',
  dismissed: 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/25',
};

const REMEDIATION_CLASS: Record<RemediationStatus, string> = {
  not_started: 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/25',
  in_progress: 'bg-amber-500/10 text-amber-600 ring-amber-500/25',
  done: 'bg-success/10 text-success ring-success/25',
  wont_fix: 'bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/25',
};

function applyFilters(items: FindingDto[], f: Filters): FindingDto[] {
  const search = f.search.trim().toLowerCase();
  const wantHeadless = f.context === 'headless';
  const wantRepo = f.context === 'repo';
  return items.filter(
    (i) =>
      (!f.severity || i.severity === f.severity) &&
      (!f.status || i.status === f.status) &&
      (!f.remediationStatus || i.remediationStatus === f.remediationStatus) &&
      (!f.scanner.trim() || i.scanner.toLowerCase().includes(f.scanner.trim().toLowerCase())) &&
      (wantRepo ? !isHeadlessContext(findingContext(i)) : wantHeadless ? isHeadlessContext(findingContext(i)) : true) &&
      (!search ||
        `${i.title} ${i.description ?? ''} ${i.ruleId ?? ''}`.toLowerCase().includes(search))
  );
}

export default function FindingsPage() {
  const { me } = useSession();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState<{ items: FindingDto[]; nextCursor: string | null }>({
    items: [],
    nextCursor: null,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  const canUpdate = !!me && canAnywhere(me, 'finding.update');

  const load = useCallback(
    async (f: Filters, cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await listFindings({
          severity: f.severity ? [f.severity] : undefined,
          status: f.status ? [f.status] : undefined,
          scanner: f.scanner.trim() || undefined,
          search: f.search.trim() || undefined,
          limit: 50,
          cursor,
        });
        setDemo(false);
        const items = applyFilters(data.items, f);
        setPage((prev) =>
          cursor ? { items: [...prev.items, ...items], nextCursor: data.nextCursor } : { items, nextCursor: data.nextCursor }
        );
      } catch (err) {
        if (err instanceof ApiRequestError && (err.code === 'UNAVAILABLE' || err.code === 'NOT_FOUND')) {
          setDemo(true);
          setPage({ items: applyFilters(DEMO_FINDINGS, f), nextCursor: null });
        } else {
          setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load findings');
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(EMPTY_FILTERS);
  }, [load]);

  const mutate = useCallback(
    async (id: string, patch: { status?: FindingStatus; remediationStatus?: RemediationStatus; assignedTo?: string | null }) => {
      setPage((prev) => ({
        ...prev,
        items: prev.items.map((it) =>
          it.id === id ? { ...it, ...patch, updatedAt: new Date().toISOString() } : it
        ),
      }));
      if (demo) return;
      try {
        const updated = await updateFinding(id, patch);
        setPage((prev) => ({ ...prev, items: prev.items.map((it) => (it.id === id ? updated : it)) }));
      } catch (err) {
        setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'update failed');
        void load(filters);
      }
    },
    [demo, filters, load]
  );

  if (!me) return null;
  if (!canAnywhere(me, 'finding.read')) return <AccessDenied permission="finding.read" />;

  return (
    <>
      <Topbar trail={['Findings']} />
      <main className="flex-1 space-y-5 overflow-y-auto p-6">
        <PageHeader
          title="Findings"
          description="Normalized security findings across scanners and stacks — triage, assign and track remediation. Headless/cross-stack findings (image, live-URL and host scans) are tagged with a Context label."
        />

        {demo ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700">
            Demo data — the findings lifecycle API (<code className="font-mono text-xs">GET /api/v1/findings</code>) is
            not reachable yet (S5-D1 in progress). Changes below are local only.
          </div>
        ) : null}

        <form
          className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card p-4 shadow-xs sm:grid-cols-3 lg:grid-cols-6 lg:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void load(filters);
          }}
        >
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Severity</span>
            <select
              value={filters.severity}
              onChange={(e) => setFilters({ ...filters, severity: e.target.value as Filters['severity'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Status</span>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              {FINDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Remediation</span>
            <select
              value={filters.remediationStatus}
              onChange={(e) => setFilters({ ...filters, remediationStatus: e.target.value as Filters['remediationStatus'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              {REMEDIATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Scanner</span>
            <Input
              value={filters.scanner}
              onChange={(e) => setFilters({ ...filters, scanner: e.target.value })}
              placeholder="semgrep, trivy…"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Context</span>
            <select
              value={filters.context}
              onChange={(e) => setFilters({ ...filters, context: e.target.value as Filters['context'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              <option value="repo">Repo</option>
              <option value="headless">Headless</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Search</span>
            <Input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="title, rule id…"
            />
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
              <Th>Severity</Th>
              <Th>Finding</Th>
              <Th>Status</Th>
              <Th>Remediation</Th>
              <Th>Assigned</Th>
              <Th>Scanner</Th>
              <Th>Context</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((f) => (
              <Fragment key={f.id}>
                <Tr
                  onClick={() => setOpenId(openId === f.id ? null : f.id)}
                  className="cursor-pointer"
                >
                  <Td>
                    <SeverityBadge severity={f.severity as Severity} />
                  </Td>
                  <Td>
                    <div className="font-medium">{f.title}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {shortId(f.id)}
                      {f.ruleId ? ` · ${f.ruleId}` : ''}
                    </div>
                  </Td>
                  <Td>
                    <Badge className={STATUS_CLASS[f.status]} dot data-status={f.status}>
                      {f.status}
                    </Badge>
                  </Td>
                  <Td>
                    <Badge className={REMEDIATION_CLASS[f.remediationStatus]} dot>
                      {f.remediationStatus}
                    </Badge>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {f.assignedTo ? shortId(f.assignedTo) : <span className="italic">unassigned</span>}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{f.scanner}</Td>
                  <Td>
                    <Badge className={CONTEXT_CLASS[findingContext(f)]} dot data-context={findingContext(f)}>
                      {findingContext(f)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDateTime(f.updatedAt)}
                  </Td>
                </Tr>
                {openId === f.id ? (
                  <RowDetail finding={f} canUpdate={canUpdate} onMutate={mutate} />
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>

        {!loading && page.items.length === 0 && !error ? (
          <p className="rounded-xl border border-dashed border-border bg-card/50 px-8 py-10 text-center text-sm text-muted-foreground">
            No findings match these filters.
          </p>
        ) : null}
        {page.nextCursor ? (
          <Button variant="outline" onClick={() => void load(filters, page.nextCursor!)} disabled={loading}>
            Load more
          </Button>
        ) : null}
        {error ? <ErrorState code="FINDINGS" message={error} /> : null}
      </main>
    </>
  );
}

function RowDetail({
  finding,
  canUpdate,
  onMutate,
}: {
  finding: FindingDto;
  canUpdate: boolean;
  onMutate: (
    id: string,
    patch: { status?: FindingStatus; remediationStatus?: RemediationStatus; assignedTo?: string | null }
  ) => void;
}) {
  const [assignInput, setAssignInput] = useState(finding.assignedTo ?? '');
  const loc = finding.location as { path?: string; start_line?: number; end_line?: number; url_param?: string } | null;
  const rem = finding.remediation as { summary?: string; references?: string[] } | null;

  return (
    <Tr>
      <Td colSpan={8} className="bg-muted/30">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
              <dt className="text-muted-foreground">scanner</dt>
              <dd>
                {finding.scanner}
                {finding.scannerVersion ? ` @ ${finding.scannerVersion}` : ''}
                {finding.imageDigest ? ` · ${finding.imageDigest}` : ''}
              </dd>
              <dt className="text-muted-foreground">context</dt>
              <dd>
                <Badge className={CONTEXT_CLASS[findingContext(finding)]} dot>
                  {findingContext(finding)}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">target</dt>
              <dd>
                {finding.targetRef ?? '—'}
                {finding.targetBranch ? ` (${finding.targetBranch})` : ''}
              </dd>
              <dt className="text-muted-foreground">location</dt>
              <dd>
                {loc?.path ?? loc?.url_param ?? '—'}
                {loc?.start_line ? `:${loc.start_line}` : ''}
                {loc?.end_line && loc.start_line !== loc.end_line ? `-${loc.end_line}` : ''}
              </dd>
              {finding.ruleId ? (
                <>
                  <dt className="text-muted-foreground">rule</dt>
                  <dd>{finding.ruleId}</dd>
                </>
              ) : null}
              {finding.cveIds?.length ? (
                <>
                  <dt className="text-muted-foreground">cves</dt>
                  <dd>{finding.cveIds.join(', ')}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">fingerprint</dt>
              <dd className="break-all">{finding.fingerprint}</dd>
            </dl>
            {finding.evidence ? (
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-card p-3 text-xs">
                {finding.evidence}
              </pre>
            ) : null}
            {rem?.summary ? (
              <div className="mt-2 text-xs">
                <span className="font-medium text-muted-foreground">Remediation: </span>
                {rem.summary}
                {rem.references?.length ? (
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {rem.references.map((r) => (
                      <li key={r}>
                        <a className="text-primary hover:underline" href={r} target="_blank" rel="noreferrer">
                          {r}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Triage</h4>
            <label className="flex items-center gap-2 text-xs">
              <span className="w-20 text-muted-foreground">Status</span>
              <select
                value={finding.status}
                disabled={!canUpdate}
                onChange={(e) => onMutate(finding.id, { status: e.target.value as FindingStatus })}
                className="h-8 flex-1 rounded-lg border border-border bg-card px-2 text-sm shadow-xs disabled:opacity-50"
              >
                {FINDING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="w-20 text-muted-foreground">Remediation</span>
              <select
                value={finding.remediationStatus}
                disabled={!canUpdate}
                onChange={(e) => onMutate(finding.id, { remediationStatus: e.target.value as RemediationStatus })}
                className="h-8 flex-1 rounded-lg border border-border bg-card px-2 text-sm shadow-xs disabled:opacity-50"
              >
                {REMEDIATION_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <label className="flex-1 space-y-1.5">
                <span className="text-xs text-muted-foreground">Assign to (user id)</span>
                <Input
                  value={assignInput}
                  disabled={!canUpdate}
                  onChange={(e) => setAssignInput(e.target.value)}
                  placeholder="uuid or empty to unassign"
                />
              </label>
              <Button
                type="button"
                disabled={!canUpdate}
                onClick={() => onMutate(finding.id, { assignedTo: assignInput.trim() || null })}
              >
                Assign
              </Button>
            </div>
            {!canUpdate ? (
              <p className="text-xs text-muted-foreground">You lack <code className="font-mono">finding.update</code> to triage.</p>
            ) : null}
          </div>
        </div>
      </Td>
    </Tr>
  );
}

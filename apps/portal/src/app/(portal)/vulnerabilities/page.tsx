'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FindingDto, FindingStatus, RemediationStatus } from '@platform/shared';
import { SEVERITIES } from '@platform/shared';
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
  listVulnerabilities,
  DEMO_VULNS,
  wpMeta,
  EMPTY_VULN_FILTERS,
  type VulnFilters,
  type UpdateRisk,
} from '@/lib/vulnerabilities';

const COMPONENT_CLASS: Record<'core' | 'plugin' | 'theme', string> = {
  core: 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/25',
  plugin: 'bg-blue-500/10 text-blue-600 ring-blue-500/25',
  theme: 'bg-fuchsia-500/10 text-fuchsia-600 ring-fuchsia-500/25',
};

const RISK_CLASS: Record<UpdateRisk, string> = {
  low: 'bg-success/10 text-success ring-success/25',
  medium: 'bg-amber-500/10 text-amber-600 ring-amber-500/25',
  high: 'bg-severity-high/10 text-severity-high ring-severity-high/25',
};

export default function VulnerabilitiesPage() {
  const { me } = useSession();
  const [filters, setFilters] = useState<VulnFilters>(EMPTY_VULN_FILTERS);
  const [items, setItems] = useState<FindingDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  const load = useCallback(
    async (f: VulnFilters) => {
      setLoading(true);
      setError(null);
      try {
        const data = await listVulnerabilities(f);
        setDemo(false);
        setItems(data.items);
      } catch (err) {
        if (err instanceof ApiRequestError && (err.code === 'UNAVAILABLE' || err.code === 'NOT_FOUND')) {
          setDemo(true);
          setItems(DEMO_VULNS);
        } else {
          setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load vulnerabilities');
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(EMPTY_VULN_FILTERS);
  }, [load]);

  if (!me) return null;
  if (!canAnywhere(me, 'finding.read')) return <AccessDenied permission="finding.read" />;

  return (
    <>
      <Topbar trail={['Security', 'Vulnerabilities']} />
      <main className="flex-1 space-y-5 overflow-y-auto p-6">
        <PageHeader
          title="WordPress Vulnerabilities"
          description="WordPress core, plugin and theme vulnerabilities correlated against WPScan / advisory intelligence by the S10-D3 engine — with CVE/advisory IDs, fixed-version remediation and update-risk metadata."
        />

        {demo ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700">
            Demo data — the findings lifecycle API (<code className="font-mono text-xs">GET /api/v1/findings</code>) is
            not reachable yet. The S10 correlation records flow through it once ingested.
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
              onChange={(e) => setFilters({ ...filters, severity: e.target.value as VulnFilters['severity'] })}
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
            <span className="text-xs font-medium text-muted-foreground">Component</span>
            <select
              value={filters.componentType}
              onChange={(e) => setFilters({ ...filters, componentType: e.target.value as VulnFilters['componentType'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              <option value="core">Core</option>
              <option value="plugin">Plugin</option>
              <option value="theme">Theme</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Update risk</span>
            <select
              value={filters.updateRisk}
              onChange={(e) => setFilters({ ...filters, updateRisk: e.target.value as VulnFilters['updateRisk'] })}
              className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
            >
              <option value="">All</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1.5">
            <input
              type="checkbox"
              checked={filters.fixedOnly}
              onChange={(e) => setFilters({ ...filters, fixedOnly: e.target.checked })}
              className="size-4 rounded border-border"
            />
            <span className="text-xs text-muted-foreground">Has fixed version</span>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Search</span>
            <Input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="slug, CVE, title…"
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
                setFilters(EMPTY_VULN_FILTERS);
                void load(EMPTY_VULN_FILTERS);
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
              <Th>Component / Vulnerability</Th>
              <Th>Installed → Fixed</Th>
              <Th>Update risk</Th>
              <Th>CVE / Advisory</Th>
              <Th>Status</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => {
              const m = wpMeta(f);
              return (
                <Fragment key={f.id}>
                  <Tr onClick={() => setOpenId(openId === f.id ? null : f.id)} className="cursor-pointer">
                    <Td>
                      <SeverityBadge severity={f.severity as Severity} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        {m ? (
                          <Badge className={COMPONENT_CLASS[m.componentType]} dot>
                            {m.componentType}
                          </Badge>
                        ) : null}
                        <span className="font-medium">{f.title}</span>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {shortId(f.id)}
                        {m ? ` · ${m.slug}` : ''}
                        {m?.majorJump ? ' · major jump' : ''}
                      </div>
                    </Td>
                    <Td className="font-mono text-xs">
                      {m?.installedVersion ?? '—'}
                      <span className="text-muted-foreground"> → </span>
                      {m?.fixedVersion ? (
                        <span className="text-success">{m.fixedVersion}</span>
                      ) : (
                        <span className="italic text-muted-foreground">no fix</span>
                      )}
                    </Td>
                    <Td>{m ? <Badge className={RISK_CLASS[m.updateRisk]} dot>{m.updateRisk}</Badge> : null}</Td>
                    <Td className="font-mono text-xs text-muted-foreground">
                      {f.cveIds?.length ? f.cveIds.join(', ') : f.advisoryIds?.length ? f.advisoryIds.join(', ') : '—'}
                    </Td>
                    <Td>
                      <Badge
                        className={
                          f.status === 'resolved'
                            ? 'bg-success/10 text-success ring-success/25'
                            : f.status === 'in_progress'
                              ? 'bg-amber-500/10 text-amber-600 ring-amber-500/25'
                              : 'bg-severity-high/10 text-severity-high ring-severity-high/25'
                        }
                        dot
                      >
                        {f.status}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(f.updatedAt)}</Td>
                  </Tr>
                  {openId === f.id ? <RowDetail finding={f} /> : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>

        {!loading && items.length === 0 && !error ? (
          <p className="rounded-xl border border-dashed border-border bg-card/50 px-8 py-10 text-center text-sm text-muted-foreground">
            No WordPress vulnerabilities match these filters.
          </p>
        ) : null}
        {error ? <ErrorState code="VULNS" message={error} /> : null}
      </main>
    </>
  );
}

function RowDetail({ finding }: { finding: FindingDto }) {
  const m = wpMeta(finding);
  const rem = finding.remediation as { summary?: string; references?: string[] } | null;
  return (
    <Tr>
      <Td colSpan={7} className="bg-muted/30">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Detail</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
              <dt className="text-muted-foreground">rule</dt>
              <dd>{finding.ruleId}</dd>
              {m ? (
                <>
                  <dt className="text-muted-foreground">component</dt>
                  <dd>
                    {m.componentType} / {m.slug} {m.active ? '(active)' : '(inactive)'}
                  </dd>
                  <dt className="text-muted-foreground">installed</dt>
                  <dd>{m.installedVersion}</dd>
                  <dt className="text-muted-foreground">fixed in</dt>
                  <dd>{m.fixedVersion ?? '— (no fix published)'}</dd>
                  <dt className="text-muted-foreground">update risk</dt>
                  <dd>{m.updateRisk}{m.majorJump ? ' (major version jump)' : ''}</dd>
                </>
              ) : null}
              {finding.cveIds?.length ? (
                <>
                  <dt className="text-muted-foreground">cves</dt>
                  <dd>{finding.cveIds.join(', ')}</dd>
                </>
              ) : null}
              {finding.advisoryIds?.length ? (
                <>
                  <dt className="text-muted-foreground">advisories</dt>
                  <dd>{finding.advisoryIds.join(', ')}</dd>
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
            <div className="text-xs text-muted-foreground">
              Status: <span className="font-medium text-foreground">{finding.status}</span> · Remediation:{' '}
              <span className="font-medium text-foreground">{(finding.remediationStatus as RemediationStatus) ?? '—'}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Triage actions live on the unified{' '}
              <a className="text-primary hover:underline" href="/findings">
                Findings
              </a>{' '}
              page (<code className="font-mono">finding.update</code>), which shares the same underlying records.
            </p>
          </div>
        </div>
      </Td>
    </Tr>
  );
}

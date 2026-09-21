'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  can as scopeCan,
  mapStacksToPolicies,
  GIT_PROVIDERS,
  type GitConnectionDto,
  type PolicyAssignmentDto,
  type ProjectDto,
  type RepoLinkDto,
  type StackDetectionDto,
} from '@platform/shared';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader, AccessDenied, EmptyState, ErrorState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { fmtDateTime, shortId } from '@/lib/format';

type Tab = 'connections' | 'repos' | 'policies';

const TABS: { id: Tab; label: string; perm: 'git.read' | null }[] = [
  { id: 'connections', label: 'Connections', perm: 'git.read' },
  { id: 'repos', label: 'Repositories & stacks', perm: 'git.read' },
  { id: 'policies', label: 'Policy assignments', perm: 'git.read' },
];

type ConnPage = { items: GitConnectionDto[]; nextCursor: string | null };

function statusBadge(s: GitConnectionDto['status']) {
  if (s === 'active') return <StatusBadge ok label="active" />;
  if (s === 'error') return <StatusBadge ok={false} label="error" />;
  return (
    <Badge dot className="bg-muted text-muted-foreground ring-border">
      revoked
    </Badge>
  );
}

/** Orgs where ANY binding of mine lives — no GET /orgs list endpoint exists. */
function useKnownOrgs() {
  const { me } = useSession();
  return useMemo(() => [...new Set(me?.bindings.map((b) => b.orgId) ?? [])], [me]);
}

/** Projects I can act on: ones I created this session + project-scoped bindings. */
function useKnownProjects() {
  const { me } = useSession();
  const [created, setCreated] = useState<ProjectDto[]>([]);
  const known = useMemo(() => {
    const fromBindings = (me?.bindings ?? [])
      .filter((b) => b.projectId)
      .map((b) => ({ id: b.projectId!, label: `project ${shortId(b.projectId!)}` }));
    return [
      ...created.map((p) => ({ id: p.id, orgId: p.orgId, label: p.name })),
      ...fromBindings.map((p) => ({ id: p.id, orgId: '', label: p.label })),
    ].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  }, [me, created]);
  return { known, created, setCreated };
}

// ---- Connections ----

function ConnectionsSection() {
  const { me } = useSession();
  const orgs = useKnownOrgs();
  const writableOrgs = useMemo(
    () =>
      orgs.filter((orgId) => me && scopeCan(me.bindings, { orgId }, 'git.manage')),
    [me, orgs]
  );
  const [orgId, setOrgId] = useState('');
  const [page, setPage] = useState<ConnPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId && orgs.length > 0) setOrgId(orgs[0]!);
  }, [orgs, orgId]);

  const load = useCallback(async (org: string, cursor?: string) => {
    setError(null);
    try {
      const data = await authFetch<ConnPage>(
        `/api/v1/git-connections?orgId=${org}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      setPage((prev) =>
        cursor && prev ? { items: [...prev.items, ...data.items], nextCursor: data.nextCursor } : data
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load connections');
    }
  }, []);

  useEffect(() => {
    if (orgId) void load(orgId);
  }, [orgId, load]);

  async function createConnection(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const f = new FormData(e.currentTarget);
    try {
      const created = await authFetch<GitConnectionDto>('/api/v1/git-connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId,
          provider: String(f.get('provider')),
          displayName: String(f.get('displayName')) || undefined,
        }),
      });
      setPage((prev) => ({ items: [created, ...(prev?.items ?? [])], nextCursor: prev?.nextCursor ?? null }));
      e.currentTarget.reset();
      setNote(`Connection created — ${created.provider} · ${shortId(created.id)}`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'CONFLICT'
            ? 'A connection for this account/provider already exists.'
            : `${err.code}: ${err.message}`
          : 'failed to create connection'
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(c: GitConnectionDto) {
    setError(null);
    setNote(null);
    try {
      const updated = await authFetch<GitConnectionDto>(`/api/v1/git-connections/${c.id}`, {
        method: 'DELETE',
      });
      setPage((prev) =>
        prev ? { ...prev, items: prev.items.map((x) => (x.id === updated.id ? updated : x)) } : prev
      );
      setNote(`Connection revoked (soft) — history preserved.`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to revoke');
    }
  }

  if (orgs.length === 0)
    return <EmptyState title="No organizations" description="You have no role bindings yet — an admin must assign you a scope before git connections can be listed." />;

  return (
    <div className="space-y-4">
      {writableOrgs.length > 0 ? (
        <Card>
          <form onSubmit={createConnection} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Select label="Organization" name="orgIdFk" value={writableOrgs.includes(orgId) ? orgId : writableOrgs[0]} disabled>
              {writableOrgs.map((id) => (
                <option key={id} value={id}>
                  org {shortId(id)}
                </option>
              ))}
            </Select>
            <Field label="Display name (optional)" name="displayName" maxLength={100} placeholder="Acme GitHub" />
            <div className="flex items-end">
              <Select label="Provider" name="provider" required defaultValue="github" className="mr-3 w-36">
                {GIT_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <Button type="submit" disabled={busy}>
                Connect
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-4">
              Secrets are exchanged via the provider install flow server-side — never pasted here.
            </p>
          </form>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <Select
          aria-label="Organization filter"
          value={orgId}
          onChange={(e) => {
            setOrgId(e.target.value);
            setPage(null);
          }}
          className="h-8 w-auto py-0 text-xs"
        >
          {orgs.map((id) => (
            <option key={id} value={id}>
              org {shortId(id)}
            </option>
          ))}
        </Select>
      </div>

      {page === null && !error ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted/50" />
      ) : (page?.items ?? []).length === 0 ? (
        <EmptyState title="No connections" description="Connect a provider to start ingesting webhook events for this organization." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Provider</Th>
              <Th>Label</Th>
              <Th>Status</Th>
              <Th>External account</Th>
              <Th>Created</Th>
              <Th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {(page?.items ?? []).map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium capitalize">{c.provider}</Td>
                <Td className="text-muted-foreground">{c.displayName ?? '—'}</Td>
                <Td>{statusBadge(c.status)}</Td>
                <Td className="font-mono text-xs text-muted-foreground">{c.externalAccountId ?? '—'}</Td>
                <Td className="text-muted-foreground">{fmtDateTime(c.createdAt)}</Td>
                <Td>
                  {c.status !== 'revoked' && writableOrgs.includes(c.orgId) ? (
                    <Button variant="destructive" className="h-7 px-2 text-xs" onClick={() => void revoke(c)}>
                      Revoke
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {page?.nextCursor ? (
        <Button variant="outline" onClick={() => void load(orgId, page.nextCursor!)}>
          Load more
        </Button>
      ) : null}

      {note ? (
        <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{note}</p>
      ) : null}
      {error ? <ErrorState code="GIT-CONNECTIONS" message={error} /> : null}
    </div>
  );
}

// ---- Repositories & stack detections ----

type RepoLinkPage = { items: RepoLinkDto[]; nextCursor: string | null };

function StackPolicyView({ detection }: { detection: StackDetectionDto }) {
  // dwight's pure mapper runs client-side: exact deny-by-default posture + rationale.
  const result = useMemo(
    () =>
      mapStacksToPolicies({
        project_id: detection.projectId,
        stacks: detection.stacks,
        headless: detection.headless,
        evidence: detection.evidence as Record<string, readonly string[]> | undefined,
      }),
    [detection]
  );
  return (
    <Card className={result.needs_manual_review ? 'border-destructive/40' : undefined}>
      <div className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Detected stacks</span>
          {detection.stacks.length === 0 ? (
            <Badge dot className="bg-destructive/10 text-destructive ring-destructive/25">none</Badge>
          ) : (
            detection.stacks.map((s) => (
              <Badge key={s} className="bg-primary/10 text-primary ring-primary/25">
                {s}
              </Badge>
            ))
          )}
          {detection.headless ? <Badge className="bg-muted text-muted-foreground ring-border">headless</Badge> : null}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            detector v{detection.detectorVersion} · {fmtDateTime(detection.detectedAt)}
          </span>
        </div>
        {result.assignments.map((a) => (
          <div key={a.stack} className="rounded-lg border border-border bg-surface p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{a.stack}</span>
              {a.policy.mode === 'enforce' ? (
                <StatusBadge ok label="enforce" />
              ) : (
                <StatusBadge ok={false} label="deny-until-manual-review" />
              )}
            </div>
            <p className="mt-1.5 text-muted-foreground">
              Cadence: sast {a.policy.scan_cadence.sast} · secrets {a.policy.scan_cadence.secrets} · sca{' '}
              {a.policy.scan_cadence.sca} · cms-vuln {a.policy.scan_cadence.cms_vuln} · tls{' '}
              {a.policy.scan_cadence.tls_posture} · dast-staging {a.policy.scan_cadence.dast_staging}
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
              {a.policy.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ))}
        {result.cross_stack_gates.length > 0 ? (
          <div className="space-y-1">
            {result.cross_stack_gates.map((g) => (
              <p key={g.gate} className="flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge ok={g.satisfied} label={g.satisfied ? 'pass' : 'fail'} />
                <span className="font-mono">{g.gate}</span> — {g.detail}
              </p>
            ))}
          </div>
        ) : null}
        {result.needs_manual_review ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Manual review required: unknown stack or failed relationship gate — nothing is scheduled until a human classifies it.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ReposSection() {
  const { me } = useSession();
  const { known: projects } = useKnownProjects();
  const orgs = useKnownOrgs();
  const [projectId, setProjectId] = useState('');
  const [links, setLinks] = useState<RepoLinkPage | null>(null);
  const [detections, setDetections] = useState<StackDetectionDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const load = useCallback(async (pid: string) => {
    setError(null);
    try {
      const [l, d] = await Promise.all([
        authFetch<RepoLinkPage>(`/api/v1/repo-links?projectId=${pid}&limit=50`),
        authFetch<StackDetectionDto[]>(`/api/v1/stack-detections?projectId=${pid}&limit=20`),
      ]);
      setLinks(l);
      setDetections(d);
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load repositories');
    }
  }, []);

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  async function linkRepo(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    const f = new FormData(e.currentTarget);
    try {
      const created = await authFetch<RepoLinkDto>('/api/v1/repo-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          connectionId: String(f.get('connectionId')),
          externalRepoId: String(f.get('externalRepoId')),
          fullName: String(f.get('fullName')),
          defaultBranch: String(f.get('defaultBranch')) || undefined,
        }),
      });
      setLinks((prev) => ({ items: [created, ...(prev?.items ?? [])], nextCursor: prev?.nextCursor ?? null }));
      e.currentTarget.reset();
      setNote(`Repository linked — ${created.fullName}`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'CONFLICT'
            ? 'This repo is already linked to that connection.'
            : `${err.code}: ${err.message}`
          : 'failed to link repository'
      );
    } finally {
      setBusy(false);
    }
  }

  if (projects.length === 0)
    return (
      <EmptyState
        title="No projects known"
        description="Create a project in Access → Orgs & projects (or via onboarding), or get a project-scoped role binding."
      />
    );

  const mayManage = me ? projects.some((p) => me.bindings.some((b) => b.projectId === p.id) || orgs.some((o) => scopeCan(me.bindings, { orgId: o, projectId: p.id }, 'project.manage'))) : false;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select
          aria-label="Project filter"
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setLinks(null);
            setDetections(null);
          }}
          className="h-8 w-auto max-w-xs py-0 text-xs"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>

      {mayManage ? (
        <Card>
          <form onSubmit={linkRepo} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-4 sm:items-end">
            <Field label="Connection id" name="connectionId" required placeholder="uuid from Connections tab" />
            <Field label="Owner/name" name="fullName" required pattern="[\w.-]+/[\w.-]+" placeholder="acme/payments-api" />
            <Field label="External repo id" name="externalRepoId" required maxLength={200} placeholder="133851902" />
            <div className="space-y-1.5">
              <Field label="Default branch" name="defaultBranch" defaultValue="main" />
            </div>
            <Button type="submit" disabled={busy} className="sm:col-span-4 sm:w-fit">
              Link repository
            </Button>
          </form>
        </Card>
      ) : null}

      {links === null && !error ? (
        <div className="h-16 animate-pulse rounded-xl bg-muted/50" />
      ) : (links?.items ?? []).length === 0 ? (
        <EmptyState title="No repositories linked" description="Link a repository to a connection so pushes and PRs can be ingested." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Repository</Th>
              <Th>Provider</Th>
              <Th>Default branch</Th>
              <Th>Linked</Th>
            </tr>
          </thead>
          <tbody>
            {(links?.items ?? []).map((l) => (
              <Tr key={l.id}>
                <Td className="font-mono text-[13px]">{l.fullName}</Td>
                <Td className="capitalize text-muted-foreground">{l.provider}</Td>
                <Td className="font-mono text-xs text-muted-foreground">{l.defaultBranch}</Td>
                <Td className="text-muted-foreground">{fmtDateTime(l.createdAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <section className="space-y-3" aria-label="Recent stack detections">
        <h2 className="text-sm font-semibold tracking-tight">Stack detections &amp; security posture</h2>
        {detections === null ? null : detections.length === 0 ? (
          <EmptyState title="No stack detections yet" description="Detections land here when the detector records output for this project." />
        ) : (
          detections.map((d) => <StackPolicyView key={d.id} detection={d} />)
        )}
      </section>

      {note ? (
        <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{note}</p>
      ) : null}
      {error ? <ErrorState code="GIT-REPOS" message={error} /> : null}
    </div>
  );
}

// ---- Policy assignments ----

const POLICY_CATALOG = ['nextjs', 'wordpress', 'payload', 'directus', 'strapi', 'unknown'] as const;

function PoliciesSection() {
  const { me } = useSession();
  const orgs = useKnownOrgs();
  const { known: projects } = useKnownProjects();
  const [assignments, setAssignments] = useState<PolicyAssignmentDto[] | null>(null);
  const [scope, setScope] = useState<{ kind: 'org' | 'project'; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope && orgs.length > 0) setScope({ kind: 'org', id: orgs[0]! });
  }, [orgs, scope]);

  const load = useCallback(async (s: { kind: 'org' | 'project'; id: string }) => {
    setError(null);
    try {
      const q = s.kind === 'org' ? `orgId=${s.id}` : `projectId=${s.id}`;
      const data = await authFetch<PolicyAssignmentDto[]>(`/api/v1/policy-assignments?${q}&limit=100`);
      setAssignments(data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load policy assignments');
    }
  }, []);

  useEffect(() => {
    if (scope) void load(scope);
  }, [scope, load]);

  async function assign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!scope) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const f = new FormData(e.currentTarget);
    try {
      const body =
        scope.kind === 'org'
          ? { policyId: String(f.get('policyId')), orgId: scope.id, enabled: f.get('enabled') === 'on' }
          : { policyId: String(f.get('policyId')), orgId: orgs[0], projectId: scope.id, enabled: f.get('enabled') === 'on' };
      const created = await authFetch<PolicyAssignmentDto>('/api/v1/policy-assignments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      setAssignments((prev) => [created, ...(prev ?? [])]);
      setNote(`Policy "${created.policyId}" assigned at ${scope.kind} scope.`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'CONFLICT'
            ? 'That policy is already assigned at this scope.'
            : `${err.code}: ${err.message}`
          : 'failed to assign policy'
      );
    } finally {
      setBusy(false);
    }
  }

  if (orgs.length === 0 && projects.length === 0)
    return <EmptyState title="No scopes available" description="You need at least one org or project binding to view policy assignments." />;

  const mayAssign = me ? orgs.some((o) => scopeCan(me.bindings, { orgId: o, projectId: scope?.kind === 'project' ? scope.id : null }, 'git.manage') || scopeCan(me.bindings, { orgId: o }, 'git.manage')) : false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Scope filter"
          value={scope ? `${scope.kind}:${scope.id}` : ''}
          onChange={(e) => {
            const [kind, id] = e.target.value.split(':');
            setScope(kind === 'project' ? { kind: 'project', id: id! } : { kind: 'org', id: id! });
            setAssignments(null);
          }}
          className="h-8 max-w-md py-0 text-xs"
        >
          {orgs.map((id) => (
            <option key={`org:${id}`} value={`org:${id}`}>
              org {shortId(id)} (all projects)
            </option>
          ))}
          {projects.map((p) => (
            <option key={`project:${p.id}`} value={`project:${p.id}`}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>

      {mayAssign ? (
        <Card>
          <form onSubmit={assign} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Select label="Policy (catalog)" name="policyId" required defaultValue={POLICY_CATALOG[0]}>
              {POLICY_CATALOG.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked className="size-4 rounded border-border accent-current" />
              Enabled
            </label>
            <span />
            <Button type="submit" disabled={busy}>
              Assign
            </Button>
            <p className="text-xs text-muted-foreground sm:col-span-4">
              Unknown/unclassified stacks are deny-by-default regardless of assignments — nothing scans until a human classifies them.
            </p>
          </form>
        </Card>
      ) : null}

      {assignments === null && !error ? (
        <div className="h-16 animate-pulse rounded-xl bg-muted/50" />
      ) : (assignments ?? []).length === 0 ? (
        <EmptyState title="No policy assignments" description="Assign a policy from the catalog above." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Policy</Th>
              <Th>Scope</Th>
              <Th>Status</Th>
              <Th>Assigned</Th>
            </tr>
          </thead>
          <tbody>
            {(assignments ?? []).map((a) => (
              <Tr key={a.id}>
                <Td className="font-mono text-[13px]">{a.policyId}</Td>
                <Td className="text-muted-foreground">
                  {a.environmentId ? `env ${shortId(a.environmentId)}` : a.projectId ? `project ${shortId(a.projectId)}` : `org ${shortId(a.orgId)}`}
                </Td>
                <Td>{a.enabled ? <StatusBadge ok label="enabled" /> : <StatusBadge ok={false} label="disabled" />}</Td>
                <Td className="text-muted-foreground">{fmtDateTime(a.createdAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {note ? (
        <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{note}</p>
      ) : null}
      {error ? <ErrorState code="GIT-POLICIES" message={error} /> : null}
    </div>
  );
}

export default function GitPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('connections');

  if (!me) return null;
  if (!canAnywhere(me, 'git.read'))
    return (
      <>
        <Topbar trail={['Git & stacks']} />
        <main className="flex-1 space-y-6 overflow-y-auto p-6">
          <PageHeader title="Git & stacks" description="Provider connections, linked repositories, detected stacks and their security policies." />
          <AccessDenied permission="git.read" />
        </main>
      </>
    );

  return (
    <>
      <Topbar trail={['Git & stacks']} />
      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        <PageHeader
          title="Git & stacks"
          description="Provider connections, linked repositories, detected stacks and the security policies they trigger."
        />
        <div role="tablist" aria-label="Git sections" className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex h-8 items-center rounded-md px-3 text-[13px] transition-colors duration-150 ease-out ${
                tab === t.id
                  ? 'bg-primary/12 font-medium text-primary ring-1 ring-inset ring-primary/20'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'connections' ? <ConnectionsSection /> : null}
        {tab === 'repos' ? <ReposSection /> : null}
        {tab === 'policies' ? <PoliciesSection /> : null}
      </main>
    </>
  );
}

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  can as scopeCan,
  type EnvironmentDto,
  type OrgDto,
  type ProjectDto,
} from '@platform/shared';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Card } from '@/components/ui/card';
import { authFetch, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { shortId } from '@/lib/format';

type StepState = 'done' | 'active' | 'locked';

function StepCard({
  n,
  title,
  state,
  doneNote,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  doneNote?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={state === 'locked' ? 'opacity-60' : undefined}>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset ${
              state === 'done'
                ? 'bg-success/10 text-success ring-success/25'
                : 'bg-primary/10 text-primary ring-primary/25'
            }`}
          >
            {state === 'done' ? '✓' : n}
          </span>
          <h2 className="text-sm font-semibold">{title}</h2>
          {doneNote ? <span className="ml-auto text-xs text-muted-foreground">{doneNote}</span> : null}
        </div>
        {state !== 'locked' ? children : null}
      </div>
    </Card>
  );
}

export default function OnboardingPage() {
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [envs, setEnvs] = useState<EnvironmentDto[]>([]);

  // Scope objects only reach us by creating them here or via own bindings — no list endpoints yet.
  const knownOrgs = useMemo(() => {
    const ids = new Set(me?.bindings.map((b) => b.orgId) ?? []);
    orgs.forEach((o) => ids.add(o.id));
    return [...ids];
  }, [me, orgs]);

  const mayCreateOrg = me ? me.bindings.some((b) => scopeCan(me.bindings, { orgId: b.orgId }, 'org.manage')) : false;
  const manageableOrgs = useMemo(
    () => knownOrgs.filter((o) => me && scopeCan(me.bindings, { orgId: o }, 'project.manage')),
    [me, knownOrgs]
  );

  if (!me) return null;

  async function post<T>(path: string, body: unknown, ok: (dto: T) => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const dto = await authFetch<T>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      ok(dto);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'CONFLICT'
            ? 'That slug is already taken.'
            : `${err.code}: ${err.message}`
          : 'request failed'
      );
    } finally {
      setBusy(false);
    }
  }

  const hasOrg = knownOrgs.length > 0;
  const hasProject = projects.length > 0 || me.bindings.some((b) => b.projectId);
  const activeStep = !mayCreateOrg && !hasOrg ? 1 : !hasProject ? 2 : 3;

  return (
    <>
      <Topbar trail={['Projects', 'Onboarding']} />
      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        <PageHeader
          title="Project onboarding"
          description="Stand up a delivery scope end to end: organization, project, environment — then wire git and stacks."
        />

        <div className="max-w-2xl space-y-4">
          <StepCard
            n={1}
            title="Organization"
            state={hasOrg ? 'done' : mayCreateOrg ? 'active' : 'locked'}
            doneNote={hasOrg ? `${knownOrgs.length} available` : undefined}
          >
            {mayCreateOrg ? (
              <form
                className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void post<OrgDto>('/api/v1/orgs', { name: String(f.get('name')), slug: String(f.get('slug')) }, (o) => {
                    setOrgs((prev) => [o, ...prev]);
                  });
                }}
              >
                <Field label="Name" name="name" required maxLength={100} placeholder="Acme Corp" />
                <Field label="Slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="acme" />
                <Button type="submit" variant="outline" disabled={busy}>
                  Create org
                </Button>
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">Your roles don&apos;t include org creation — using your existing scopes.</p>
            )}
          </StepCard>

          <StepCard
            n={2}
            title="Project"
            state={hasProject ? 'done' : activeStep === 2 ? 'active' : 'locked'}
            doneNote={hasProject ? `${projects.length} created this session` : undefined}
          >
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void post<ProjectDto>(
                  '/api/v1/projects',
                  { orgId: String(f.get('orgId')), name: String(f.get('name')), slug: String(f.get('slug')) },
                  (p) => setProjects((prev) => [p, ...prev])
                );
              }}
            >
              <Select label="Organization" name="orgId" required defaultValue={manageableOrgs[0]}>
                {manageableOrgs.map((id) => (
                  <option key={id} value={id}>
                    org {shortId(id)}
                  </option>
                ))}
              </Select>
              <Field label="Name" name="name" required maxLength={100} placeholder="Payments" />
              <Field label="Slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="payments" />
              <Button type="submit" variant="outline" disabled={busy || manageableOrgs.length === 0}>
                Create project
              </Button>
            </form>
          </StepCard>

          <StepCard n={3} title="Environment" state={activeStep === 3 ? 'active' : 'locked'}>
            <form
              className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void post<EnvironmentDto>('/api/v1/environments', { projectId: String(f.get('projectId')), name: String(f.get('name')) }, () => {});
              }}
            >
              <Select
                label="Project"
                name="projectId"
                required
                defaultValue={
                  projects[0]?.id ?? me.bindings.find((b) => b.projectId)?.projectId ?? ''
                }
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {me.bindings
                  .filter((b) => b.projectId && !projects.some((p) => p.id === b.projectId))
                  .map((b) => (
                    <option key={b.projectId} value={b.projectId!}>
                      project {shortId(b.projectId!)}
                    </option>
                  ))}
              </Select>
              <Field label="Environment name" name="name" required maxLength={100} placeholder="production" />
              <Button type="submit" variant="outline" disabled={busy || (!projects.length && !me.bindings.some((b) => b.projectId))}>
                Create environment
              </Button>
            </form>
          </StepCard>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold">Wire up delivery</h2>
                <p className="text-xs text-muted-foreground">
                  Connect a provider, link the repository and record a stack detection — all in Git &amp; stacks.
                </p>
              </div>
              <Link
                href="/git"
                className="inline-flex h-8 items-center rounded-lg bg-primary/12 px-3 text-[13px] font-medium text-primary ring-1 ring-inset ring-primary/20 transition-colors duration-150 ease-out hover:bg-primary/20"
              >
                Go to Git &amp; stacks →
              </Link>
            </div>
          </Card>

          {error ? (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </main>
    </>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { can as scopeCan, type EnvironmentDto, type OrgDto, type ProjectDto } from '@platform/shared';
import { AccessDenied } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Card } from '@/components/ui/card';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { shortId } from '@/lib/format';

export function ScopesTab() {
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Scope objects only reach us by creating them here or via own bindings — no list endpoints yet.
  const [orgs, setOrgs] = useState<OrgDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);

  const orgManageable = useMemo(() => {
    if (!me) return [] as string[];
    return [...new Set(me.bindings.map((b) => b.orgId))].filter((orgId) =>
      scopeCan(me.bindings, { orgId }, 'project.manage')
    );
  }, [me]);

  if (!me) return null;
  const mayOrgs = canAnywhere(me, 'org.manage');
  const mayProjects = orgManageable.length > 0;
  if (!mayOrgs && !mayProjects) return <AccessDenied permission="org.manage / project.manage" />;

  async function post<T>(path: string, body: unknown, ok: (dto: T) => void, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const dto = await authFetch<T>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      ok(dto);
      setNote(`${done} — id ${shortId((dto as { id: string }).id)}`);
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

  const knownProjects: { id: string; label: string }[] = [
    ...projects.map((p) => ({ id: p.id, label: p.name })),
    ...me.bindings.filter((b) => b.projectId).map((b) => ({ id: b.projectId!, label: `project ${shortId(b.projectId!)}` })),
  ].filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-4 lg:grid-cols-3">
      {mayOrgs ? (
        <Card>
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void post<OrgDto>(
                '/api/v1/orgs',
                { name: String(f.get('name')), slug: String(f.get('slug')) },
                (o) => setOrgs((prev) => [o, ...prev]),
                'Organization created'
              );
            }}
          >
            <h2 className="text-sm font-semibold">New organization</h2>
            <Field label="Name" name="name" required maxLength={100} placeholder="Acme Corp" />
            <Field label="Slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="acme" />
            <Button type="submit" variant="outline" disabled={busy}>
              Create org
            </Button>
          </form>
        </Card>
      ) : null}

      {mayProjects ? (
        <Card>
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void post<ProjectDto>(
                '/api/v1/projects',
                { orgId: String(f.get('orgId')), name: String(f.get('name')), slug: String(f.get('slug')) },
                (p) => setProjects((prev) => [p, ...prev]),
                'Project created'
              );
            }}
          >
            <h2 className="text-sm font-semibold">New project</h2>
            <Select label="Organization" name="orgId" required defaultValue={orgManageable[0]}>
              {orgManageable.map((id) => (
                <option key={id} value={id}>
                  org {shortId(id)}
                </option>
              ))}
            </Select>
            <Field label="Name" name="name" required maxLength={100} placeholder="Payments" />
            <Field label="Slug" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="payments" />
            <Button type="submit" variant="outline" disabled={busy}>
              Create project
            </Button>
          </form>
        </Card>
      ) : null}

      {mayProjects ? (
        <Card>
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void post<EnvironmentDto>(
                '/api/v1/environments',
                { projectId: String(f.get('projectId')), name: String(f.get('name')) },
                () => {},
                'Environment created'
              );
            }}
          >
            <h2 className="text-sm font-semibold">New environment</h2>
            <Select label="Project" name="projectId" required defaultValue={knownProjects[0]?.id ?? ''}>
              {knownProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Field label="Environment name" name="name" required maxLength={100} placeholder="prod" />
            <Button type="submit" variant="outline" disabled={busy || knownProjects.length === 0}>
              Create environment
            </Button>
            {knownProjects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No projects known yet — create one above or get a project-scoped binding.
              </p>
            ) : null}
          </form>
        </Card>
      ) : null}

      {note ? (
        <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success lg:col-span-3">
          {note}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive lg:col-span-3">
          {error}
        </p>
      ) : null}
    </div>
  );
}

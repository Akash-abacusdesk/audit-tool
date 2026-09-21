'use client';

import { useEffect, useMemo, useState } from 'react';
import { permissionsFor, ROLES, type RoleBindingDto, type UserDto } from '@platform/shared';
import { AccessDenied, ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { shortId } from '@/lib/format';

function Select({ label, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs transition-colors duration-150 outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
        {...props}
      />
    </label>
  );
}

export function RolesTab() {
  const { me } = useSession();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const manageableOrgs = useMemo(() => {
    if (!me) return [] as string[];
    const orgs = new Set<string>();
    for (const b of me.bindings) {
      if (permissionsFor(me.bindings, { orgId: b.orgId }).has('role.assign')) {
        orgs.add(b.orgId);
      }
    }
    return [...orgs];
  }, [me]);

  const listUsers = canAnywhere(me, 'user.manage');
  useEffect(() => {
    if (!listUsers) return;
    authFetch<{ items: UserDto[] }>('/api/v1/users?limit=200')
      .then((p) => setUsers(p.items))
      .catch(() => setUsers(null));
  }, [listUsers]);

  if (!me) return null;
  if (!canAnywhere(me, 'role.assign')) return <AccessDenied permission="role.assign" />;

  async function grant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const f = new FormData(e.currentTarget);
    try {
      const binding = await authFetch<RoleBindingDto>('/api/v1/role-bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: String(f.get('userId')),
          role: String(f.get('role')),
          orgId: String(f.get('orgId')),
        }),
      });
      setResult(`Granted ${binding.role} in org ${shortId(binding.orgId)} (binding ${shortId(binding.id)}).`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'FORBIDDEN'
            ? 'You must hold the role yourself at the exact scope you are granting.'
            : `${err.code}: ${err.message}`
          : 'failed to grant role'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-3xl grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <form onSubmit={grant} className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Grant a role</h2>
          {manageableOrgs.length === 0 ? (
            <ErrorState
              code="NO_SCOPE"
              message="None of your bindings grant role.assign at any scope, so there is nothing to grant against."
            />
          ) : (
            <>
              {users ? (
                <Select label="User" name="userId" required defaultValue="">
                  <option value="" disabled>
                    Select user…
                  </option>
                  {users
                    .filter((u) => u.id !== me.user.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} ({u.email})
                      </option>
                    ))}
                </Select>
              ) : (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">User ID</span>
                  <Input name="userId" required placeholder="uuid" pattern="[0-9a-f-]{36}" />
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Select label="Role" name="role" required defaultValue="developer">
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Select label="Scope (org)" name="orgId" required defaultValue={manageableOrgs[0]}>
                  {manageableOrgs.map((id) => (
                    <option key={id} value={id}>
                      org {shortId(id)}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" disabled={busy}>
                Grant binding
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Org-level grants only for now — project/environment pickers land with scope list
                endpoints. You cannot grant to yourself.
              </p>
            </>
          )}
          {result ? (
            <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{result}</p>
          ) : null}
          {error ? <ErrorState code="GRANT_FAILED" message={error} /> : null}
        </form>
      </Card>

      <Card>
        <div className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">My bindings</h2>
          <Table>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Scope</Th>
              </tr>
            </thead>
            <tbody>
              {me.bindings.map((b) => (
                <Tr key={b.id}>
                  <Td>
                    <Badge className="bg-primary/10 text-primary ring-primary/25">{b.role}</Badge>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    org {shortId(b.orgId)}
                    {b.projectId ? ` · proj ${shortId(b.projectId)}` : ''}
                    {b.environmentId ? ` · env ${shortId(b.environmentId)}` : ''}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Revoking needs a role-binding list endpoint (server has none yet) — display only today.
          </p>
        </div>
      </Card>
    </div>
  );
}

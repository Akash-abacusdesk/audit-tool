'use client';

import { useCallback, useEffect, useState } from 'react';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader, AccessDenied, ErrorState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Permission, UserDto } from '@platform/shared';
import { RolesTab } from './roles-tab';
import { ScopesTab } from './scopes-tab';

type Tab = 'users' | 'roles' | 'scopes';

const TABS: { id: Tab; label: string; perm: Permission | null }[] = [
  { id: 'users', label: 'Users', perm: 'user.manage' },
  { id: 'roles', label: 'Role assignments', perm: 'role.assign' },
  { id: 'scopes', label: 'Orgs & projects', perm: null },
];

function UsersSection() {
  const { me, refresh } = useSession();
  const [page, setPage] = useState<{ items: UserDto[]; nextCursor: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setError(null);
    try {
      const data = await authFetch<{ items: UserDto[]; nextCursor: string | null }>(
        `/api/v1/users?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      setPage((prev) =>
        cursor && prev ? { items: [...prev.items, ...data.items], nextCursor: data.nextCursor } : data
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load users');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      const created = await authFetch<UserDto>('/api/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(f.get('email')),
          password: String(f.get('password')),
          displayName: String(f.get('displayName')),
        }),
      });
      setPage((prev) => ({ items: [created, ...(prev?.items ?? [])], nextCursor: prev?.nextCursor ?? null }));
      e.currentTarget.reset();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'CONFLICT'
            ? 'Email already registered.'
            : `${err.code}: ${err.message}`
          : 'failed to create user'
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: UserDto) {
    setError(null);
    try {
      const updated = await authFetch<UserDto>(`/api/v1/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      setPage((prev) =>
        prev ? { ...prev, items: prev.items.map((x) => (x.id === u.id ? updated : x)) } : prev
      );
      if (u.id === me?.user.id) void refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to update user');
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={createUser} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <Input name="email" type="email" required placeholder="dev@company.com" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <Input name="displayName" required maxLength={100} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Temp password</span>
            <Input name="password" type="password" required minLength={12} autoComplete="new-password" />
          </label>
          <Button type="submit" disabled={busy}>
            Create user
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-4">
            Minimum 12 characters. Share the temp password out-of-band; the user changes it in Settings.
          </p>
        </form>
      </Card>

      {page === null && !error ? (
        <div className="h-24 animate-pulse rounded-xl bg-muted/50" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Email</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {(page?.items ?? []).map((u) => {
              const self = u.id === me?.user.id;
              return (
                <Tr key={u.id}>
                  <Td>
                    <span className="font-medium">{u.displayName}</span>
                    {self ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                  </Td>
                  <Td className="text-muted-foreground">{u.email}</Td>
                  <Td>
                    <StatusBadge ok={u.isActive} label={u.isActive ? 'active' : 'deactivated'} />
                  </Td>
                  <Td className="text-muted-foreground">{fmtDateTime(u.createdAt)}</Td>
                  <Td>
                    <Button
                      variant={u.isActive ? 'destructive' : 'outline'}
                      disabled={self}
                      title={self ? 'You cannot deactivate your own account' : undefined}
                      onClick={() => void toggleActive(u)}
                        className="h-7 px-2 text-xs"
                    >
                      {u.isActive ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {page?.nextCursor ? (
        <Button variant="outline" onClick={() => void load(page.nextCursor!)}>
          Load more
        </Button>
      ) : null}

      {error ? <ErrorState code="USERS" message={error} /> : null}
    </div>
  );
}

export default function AccessPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('users');

  if (!me) return null;

  return (
    <>
      <Topbar trail={['Access']} />
      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        <PageHeader
          title="Access"
          description="Users, role bindings and scope hierarchy — who can do what, where."
        />
        <div role="tablist" aria-label="Access sections" className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
          {TABS.map((t) => {
            const locked = t.perm !== null && !canAnywhere(me, t.perm);
            return (
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
                {locked ? (
                  <Badge className="ml-2 border-0 bg-muted px-1.5 text-[10px] text-muted-foreground ring-border">
                    no perm
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>

        {tab === 'users' ? (
          canAnywhere(me, 'user.manage') ? (
            <UsersSection />
          ) : (
            <AccessDenied permission="user.manage" />
          )
        ) : null}
        {tab === 'roles' ? <RolesTab /> : null}
        {tab === 'scopes' ? <ScopesTab /> : null}
      </main>
    </>
  );
}

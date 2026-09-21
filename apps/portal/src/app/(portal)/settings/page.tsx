'use client';

import { useCallback, useEffect, useState } from 'react';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/form';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { authFetch, canAnywhere, useSession } from '@/lib/auth';
import { ApiRequestError } from '@/lib/api';
import { fmtDateTime, shortId } from '@/lib/format';
import {
  TELEGRAM_ACTIONS,
  createTelegramAuthorization,
  listTelegramAuthorizations,
  revokeTelegramAuthorization,
} from '@/lib/telegram';
import type { TelegramAuthorizationDto } from '@platform/shared';

export default function SettingsPage() {
  const { me, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!me) return null;

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNote(null);
    setError(null);
    const f = new FormData(e.currentTarget);
    const newPassword = String(f.get('newPassword'));
    if (newPassword !== String(f.get('confirm'))) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await authFetch('/api/v1/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: String(f.get('currentPassword')), newPassword }),
      });
      setNote('Password changed. Your other sessions were signed out.');
      e.currentTarget.reset();
      void refresh();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.code === 'UNAUTHORIZED'
            ? 'Current password is incorrect.'
            : `${err.code}: ${err.message}`
          : 'failed to change password'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar trail={['Settings']} />
      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        <PageHeader title="Settings" description="Your account and session." />

        <div className="grid max-w-3xl grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <div className="space-y-2 p-4">
              <h2 className="text-sm font-semibold">Profile</h2>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium">{me.user.displayName}</dd>
                <dt className="text-muted-foreground">Email</dt>
                <dd>{me.user.email}</dd>
                <dt className="text-muted-foreground">User ID</dt>
                <dd className="font-mono text-xs">{me.user.id}</dd>
                <dt className="text-muted-foreground">Member since</dt>
                <dd>{fmtDateTime(me.user.createdAt)}</dd>
              </dl>
            </div>
          </Card>

          <Card>
            <form onSubmit={changePassword} className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">Change password</h2>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Current password</span>
                <Input name="currentPassword" type="password" required autoComplete="current-password" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">New password (min 12)</span>
                <Input name="newPassword" type="password" required minLength={12} autoComplete="new-password" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Confirm new password</span>
                <Input name="confirm" type="password" required minLength={12} autoComplete="new-password" />
              </label>
              <Button type="submit" disabled={busy}>
                Change password
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Changing your password signs out every other session.
              </p>
              {note ? (
                <p role="status" className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
                  {note}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </form>
          </Card>

          <Card className="lg:col-span-2">
            <div className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">My access</h2>
              <Table>
                <thead>
                  <tr>
                    <Th>Role</Th>
                    <Th>Org</Th>
                    <Th>Project</Th>
                    <Th>Environment</Th>
                    <Th>Granted</Th>
                  </tr>
                </thead>
                <tbody>
                  {me.bindings.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <Badge className="bg-primary/10 text-primary ring-primary/25">{b.role}</Badge>
                      </Td>
                      <Td className="font-mono text-xs">{shortId(b.orgId)}</Td>
                      <Td className="font-mono text-xs">{b.projectId ? shortId(b.projectId) : '—'}</Td>
                      <Td className="font-mono text-xs">{b.environmentId ? shortId(b.environmentId) : '—'}</Td>
                      <Td className="text-muted-foreground">{fmtDateTime(b.createdAt)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>

          <TelegramPreferences canManage={canAnywhere(me, 'telegram.manage')} />
        </div>
      </main>
    </>
  );
}

function TelegramPreferences({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<TelegramAuthorizationDto[]>([]);
  const [includeRevoked, setIncludeRevoked] = useState(false);
  const [actions, setActions] = useState<string[]>(['status']);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!canManage) return;
    try {
      setRows(await listTelegramAuthorizations(includeRevoked));
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to load Telegram settings');
    }
  }, [canManage, includeRevoked]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNote(null);
    setError(null);
    if (!actions.length) {
      setError('Select at least one Telegram action.');
      return;
    }
    const f = new FormData(e.currentTarget);
    const orgId = String(f.get('orgId')).trim();
    setBusy(true);
    try {
      await createTelegramAuthorization({
        bot_id: String(f.get('botId')).trim(),
        chat_id: String(f.get('chatId')).trim(),
        user_id: String(f.get('userId')).trim(),
        actions,
        ...(orgId
          ? {
              scope: {
                orgId,
                ...(String(f.get('projectId')).trim() ? { projectId: String(f.get('projectId')).trim() } : {}),
                ...(String(f.get('environmentId')).trim()
                  ? { environmentId: String(f.get('environmentId')).trim() }
                  : {}),
              },
            }
          : {}),
      });
      setNote('Telegram authorization saved. Callback authorization uses this fresh allow-list.');
      e.currentTarget.reset();
      setActions(['status']);
      await reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to save Telegram settings');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setNote(null);
    setError(null);
    setBusy(true);
    try {
      await revokeTelegramAuthorization(id);
      setNote('Telegram authorization revoked.');
      await reload();
    } catch (err) {
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'failed to revoke Telegram settings');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Telegram Ops preferences</h2>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
              Map Telegram bot/chat/user triples to allowed operations. No callback payload, token, secret, or source
              content is shown here.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeRevoked}
              onChange={(e) => setIncludeRevoked(e.target.checked)}
              disabled={!canManage}
            />
            include revoked
          </label>
        </div>

        {!canManage ? (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Your role does not include <code className="font-mono text-xs">telegram.manage</code>.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-background/40 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Bot ID" name="botId" required placeholder="ops-prod" />
              <Field label="Chat ID" name="chatId" required placeholder="-1001234567890" />
              <Field label="Telegram user ID" name="userId" required placeholder="123456789" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Org ID (uuid)" name="orgId" placeholder="optional" />
              <Field label="Project ID (uuid)" name="projectId" placeholder="optional" />
              <Field label="Environment ID (uuid)" name="environmentId" placeholder="optional" />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">Allowed operations</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {TELEGRAM_ACTIONS.map((action) => (
                  <label key={action} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={(e) =>
                        setActions((prev) =>
                          e.target.checked ? [...prev, action] : prev.filter((x) => x !== action)
                        )
                      }
                    />
                    <span className="font-mono text-xs">{action}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Button type="submit" disabled={busy}>
              Save Telegram authorization
            </Button>
          </form>
        )}

        {note ? <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">{note}</p> : null}
        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Table>
          <thead>
            <tr>
              <Th>Bot / chat / user</Th>
              <Th>Actions</Th>
              <Th>Scope</Th>
              <Th>Created</Th>
              <Th>Status</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Tr>
                <Td colSpan={6} className="text-muted-foreground">
                  {canManage ? 'No Telegram authorizations yet.' : 'Access required.'}
                </Td>
              </Tr>
            ) : (
              rows.map((row) => (
                <Tr key={row.id}>
                  <Td className="space-y-1 font-mono text-xs">
                    <div>{row.bot_id}</div>
                    <div className="text-muted-foreground">{row.chat_id}</div>
                    <div className="text-muted-foreground">{row.user_id}</div>
                  </Td>
                  <Td className="max-w-xs">
                    <div className="flex flex-wrap gap-1">
                      {row.actions.map((action) => (
                        <Badge key={action} className="bg-primary/10 text-primary ring-primary/25">
                          {action}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {[row.org_id, row.project_id, row.environment_id].filter(Boolean).map((x) => shortId(String(x))).join(' / ') || 'global'}
                  </Td>
                  <Td className="text-muted-foreground">{fmtDateTime(row.created_at)}</Td>
                  <Td>
                    <Badge
                      dot
                      className={
                        row.revoked_at
                          ? 'bg-muted text-muted-foreground ring-border'
                          : 'bg-success/10 text-success ring-success/25'
                      }
                    >
                      {row.revoked_at ? 'revoked' : 'active'}
                    </Badge>
                  </Td>
                  <Td>
                    {!row.revoked_at && canManage ? (
                      <Button type="button" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void revoke(row.id)}>
                        Revoke
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

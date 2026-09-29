'use client';

import { useEffect, useState } from 'react';
import type { SiteDto, TeamMemberDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { useMeContext } from '../../../lib/MeContext';
import { PageHeader } from '../../../components/PageHeader';

const SCAN_BADGE: Record<string, string> = { completed: 'badge-low', failed: 'badge-critical', partial: 'badge-medium' };

export default function SitesPage() {
  const me = useMeContext();
  const orgId = me.bindings[0]?.orgId ?? '';
  const [sites, setSites] = useState<SiteDto[] | null>(null);
  const [members, setMembers] = useState<TeamMemberDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', url: '', ownerUserId: '' });
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const [s, m] = await Promise.all([apiFetch<SiteDto[]>('/sites'), apiFetch<TeamMemberDto[]>('/team-members')]);
      setSites(s);
      setMembers(m.filter((x) => x.isActive));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'failed to load sites');
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : fallback);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await run(async () => {
      await apiFetch('/sites', {
        method: 'POST',
        body: { orgId, name: form.name, ...(form.url ? { url: form.url } : {}), ...(form.ownerUserId ? { ownerUserId: form.ownerUserId } : {}) },
      });
      setForm({ name: '', url: '', ownerUserId: '' });
    }, 'could not add the site');
    setSaving(false);
  }

  const setOwner = (s: SiteDto, ownerUserId: string) =>
    run(() => apiFetch(`/sites/${s.id}`, { method: 'PATCH', body: { ownerUserId: ownerUserId || null } }), 'could not change the owner');
  const toggle = (s: SiteDto) =>
    run(() => apiFetch(`/sites/${s.id}`, { method: 'PATCH', body: { status: s.status === 'active' ? 'paused' : 'active' } }), 'could not update the site');
  const testAlert = (s: SiteDto) =>
    run(async () => {
      const r = await apiFetch<{ recipients: number }>(`/sites/${s.id}/test-alert`, { method: 'POST', body: {} });
      setNotice(r.recipients === 0 ? `No one to alert for ${s.name}: set a Telegram chat id on the owner or an admin.` : `Test alert sent to ${r.recipients} chat${r.recipients === 1 ? '' : 's'}.`);
    }, 'could not send the test alert');

  return (
    <div>
      <PageHeader title="Sites" subtitle="Each site has one team member who operates it. When a scan fails they and the admins are alerted on Telegram, and a task is registered for them." />
      <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          {error && <p className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
          {notice && <p className="mb-4 rounded-lg bg-[var(--color-accent)]/10 px-3 py-2 text-sm text-[var(--color-accent)]">{notice}</p>}
          <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
            {sites === null && <p className="p-4 text-sm text-[var(--color-text-dim)]">Loading…</p>}
            {sites?.length === 0 && <p className="p-4 text-sm text-[var(--color-text-dim)]">No sites yet. Add the first one.</p>}
            {sites?.map((s) => (
              <div key={s.id} className="row-hover px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.name}</span>
                  {s.status === 'paused' && <span className="badge-neutral">paused</span>}
                  {s.lastScan && <span className={SCAN_BADGE[s.lastScan.status] ?? 'badge-neutral'}>last scan {s.lastScan.status}</span>}
                  {!s.lastScan && <span className="badge-neutral">no scans yet</span>}
                </div>
                <div className="text-xs text-[var(--color-text-dim)]">
                  {s.url ?? 'no URL'} · {s.openFindings} open finding{s.openFindings === 1 ? '' : 's'} · {s.tasks} task{s.tasks === 1 ? '' : 's'}
                  {s.lastScan && ` · ${s.lastScan.tool} ${new Date(s.lastScan.at).toLocaleString()}`}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <label className="label !m-0">Handled by</label>
                  <select className="input !w-auto !py-1.5 text-xs" value={s.owner?.id ?? ''} onChange={(e) => setOwner(s, e.target.value)}>
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                  {s.owner && !s.owner.telegramChatId && <span className="text-xs text-[var(--color-medium)]">no Telegram chat id — they won&apos;t get alerts</span>}
                  <span className="flex-1" />
                  <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => testAlert(s)}>Send test alert</button>
                  <button className="btn-ghost !px-3 !py-1.5 text-xs" onClick={() => toggle(s)}>{s.status === 'active' ? 'Pause' : 'Resume'}</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={create} className="surface h-fit p-5">
          <h2 className="mb-4 text-sm font-semibold">Add site</h2>
          <label className="label mb-1.5 block">Name</label>
          <input className="input mb-3.5" placeholder="Acme Shop" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
          <label className="label mb-1.5 block">URL</label>
          <input className="input mb-3.5" type="url" placeholder="https://shop.example.com" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
          <label className="label mb-1.5 block">Handled by</label>
          <select className="input mb-5" value={form.ownerUserId} onChange={(e) => setForm((f) => ({ ...f, ownerUserId: e.target.value }))}>
            <option value="">Assign later</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
          <button className="btn-primary w-full" disabled={saving || !orgId}>{saving ? 'Adding…' : 'Add site'}</button>
          {members.length === 0 && <p className="mt-3 text-xs text-[var(--color-text-dim)]">Add a team member first (Team page) to assign someone.</p>}
        </form>
      </div>
    </div>
  );
}

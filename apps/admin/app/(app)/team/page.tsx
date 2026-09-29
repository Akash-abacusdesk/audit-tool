'use client';

import { useEffect, useState } from 'react';
import type { TeamMemberDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { PageHeader } from '../../../components/PageHeader';

const ROLE_LABEL: Record<string, string> = { manager: 'admin', security_admin: 'security admin', team_lead: 'team lead', developer: 'developer', project_coordinator: 'coordinator' };

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: '', email: '', password: '', telegramChatId: '' });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  async function refresh() {
    try {
      setMembers(await apiFetch<TeamMemberDto[]>('/team-members'));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'failed to load team');
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/team-members', {
        method: 'POST',
        body: { displayName: form.displayName, email: form.email, password: form.password, ...(form.telegramChatId ? { telegramChatId: form.telegramChatId } : {}) },
      });
      setForm({ displayName: '', email: '', password: '', telegramChatId: '' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'could not add the team member');
    } finally {
      setSaving(false);
    }
  }

  async function saveChat(m: TeamMemberDto) {
    setError(null);
    try {
      const v = (editing[m.id] ?? '').trim();
      await apiFetch(`/team-members/${m.id}`, { method: 'PATCH', body: { telegramChatId: v === '' ? null : v } });
      setEditing((s) => {
        const { [m.id]: _drop, ...rest } = s;
        return rest;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'could not save the chat id');
    }
  }

  return (
    <div>
      <PageHeader title="Team" subtitle="The people who operate your sites. Their Telegram chat receives the alert when a scan on their site fails." />
      <div className="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          {error && <p className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
          <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
            {members === null && <p className="p-4 text-sm text-[var(--color-text-dim)]">Loading…</p>}
            {members?.length === 0 && <p className="p-4 text-sm text-[var(--color-text-dim)]">No team members yet.</p>}
            {members?.map((m) => {
              const draft = editing[m.id];
              return (
                <div key={m.id} className="row-hover px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{m.displayName}</span>
                    {m.roles.map((r) => (
                      <span key={r} className="badge-info">{ROLE_LABEL[r] ?? r}</span>
                    ))}
                    {!m.isActive && <span className="badge-neutral">inactive</span>}
                  </div>
                  <div className="text-xs text-[var(--color-text-dim)]">
                    {m.email} · {m.sites.length ? `handles ${m.sites.map((s) => s.name).join(', ')}` : 'no sites assigned'}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="input !py-1.5 text-xs"
                      placeholder="Telegram chat id (not set: no alerts)"
                      value={draft ?? m.telegramChatId ?? ''}
                      onChange={(e) => setEditing((s) => ({ ...s, [m.id]: e.target.value }))}
                    />
                    <button className="btn-ghost !px-3 !py-1.5 text-xs" disabled={draft === undefined || draft === (m.telegramChatId ?? '')} onClick={() => saveChat(m)}>
                      Save
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <form onSubmit={create} className="surface h-fit p-5">
          <h2 className="mb-4 text-sm font-semibold">Add team member</h2>
          <label className="label mb-1.5 block">Name</label>
          <input className="input mb-3.5" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} required />
          <label className="label mb-1.5 block">Email</label>
          <input className="input mb-3.5" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
          <label className="label mb-1.5 block">Initial password (12+ characters)</label>
          <input className="input mb-3.5" type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
          <label className="label mb-1.5 block">Telegram chat id</label>
          <input className="input mb-2" placeholder="e.g. 123456789" value={form.telegramChatId} onChange={(e) => setForm((f) => ({ ...f, telegramChatId: e.target.value }))} />
          <p className="mb-5 text-xs text-[var(--color-text-dim)]">
            The person must open a chat with the alerts bot and press <b>Start</b> first — Telegram does not let bots message someone who hasn&apos;t. Their id can be found by messaging <b>@userinfobot</b>.
          </p>
          <button className="btn-primary w-full" disabled={saving}>{saving ? 'Adding…' : 'Add team member'}</button>
        </form>
      </div>
    </div>
  );
}

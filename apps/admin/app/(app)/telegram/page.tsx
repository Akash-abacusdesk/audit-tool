'use client';

import { useEffect, useState } from 'react';
import * as motion from 'motion/react-m';
import type { TelegramAuthorizationDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { PageHeader } from '../../../components/PageHeader';

const COMMON_ACTIONS = ['finding.alert.critical', 'jit.request', 'jit.approve', 'jit.revoke'];

export default function TelegramPage() {
  const [items, setItems] = useState<TelegramAuthorizationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ bot_id: '', chat_id: '', user_id: '', actions: [] as string[] });
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      setItems(await apiFetch<TelegramAuthorizationDto[]>('/telegram/authorizations'));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'failed to load authorizations');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggleAction(action: string) {
    setForm((f) => ({
      ...f,
      actions: f.actions.includes(action) ? f.actions.filter((a) => a !== action) : [...f.actions, action],
    }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/telegram/authorizations', { method: 'POST', body: form });
      setForm({ bot_id: '', chat_id: '', user_id: '', actions: [] });
      refresh();
    } catch (e2) {
      setError(e2 instanceof ApiRequestError ? e2.message : 'create failed');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    try {
      await apiFetch(`/telegram/authorizations/${id}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'revoke failed');
    }
  }

  return (
    <div>
      <PageHeader title="Telegram Alerts" subtitle="Chats authorized to receive control-plane alerts and act on them." />
      <div className="grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          {error && <p className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}

          <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
            {items?.length === 0 && <p className="p-4 text-sm text-[var(--color-text-dim)]">No bindings yet.</p>}
            {items?.map((it, i) => (
              <motion.div
                key={it.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className="row-hover flex items-center gap-3 px-4 py-3.5"
              >
                <div className="flex-1">
                  <div className="text-sm font-medium">chat {it.chat_id}</div>
                  <div className="text-xs text-[var(--color-text-dim)]">{it.actions.join(', ')}</div>
                </div>
                {it.revoked_at ? (
                  <span className="badge-neutral">revoked</span>
                ) : (
                  <button className="btn-danger" onClick={() => revoke(it.id)}>Revoke</button>
                )}
              </motion.div>
            ))}
          </div>
        </div>

        <form onSubmit={create} className="surface h-fit p-5">
          <h2 className="mb-4 text-sm font-semibold">New binding</h2>

          <label className="label mb-1.5 block">Bot ID</label>
          <input className="input mb-3.5" value={form.bot_id} onChange={(e) => setForm((f) => ({ ...f, bot_id: e.target.value }))} required />

          <label className="label mb-1.5 block">Chat ID</label>
          <input className="input mb-3.5" value={form.chat_id} onChange={(e) => setForm((f) => ({ ...f, chat_id: e.target.value }))} required />

          <label className="label mb-1.5 block">User ID</label>
          <input className="input mb-3.5" value={form.user_id} onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))} required />

          <label className="label mb-2 block">Actions</label>
          <div className="mb-5 flex flex-wrap gap-2">
            {COMMON_ACTIONS.map((a) => (
              <button
                type="button"
                key={a}
                onClick={() => toggleAction(a)}
                className={form.actions.includes(a) ? 'btn-primary' : 'btn-ghost'}
              >
                {a}
              </button>
            ))}
          </div>

          <button type="submit" className="btn-primary w-full" disabled={saving || form.actions.length === 0}>
            {saving ? 'Saving…' : 'Create binding'}
          </button>
        </form>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { BellRinging, Check, Plus } from '@phosphor-icons/react';
import type { TelegramAuthorizationDto } from '@platform/shared';
import { apiFetch } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { errMsg, useApi } from '../../../lib/useApi';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Panel, SkeletonRows, spring, useToast } from '../../../components/ui';

const EVENTS: { value: string; label: string; help: string }[] = [
  { value: 'finding.alert.critical', label: 'Critical findings', help: 'A new critical finding is discovered' },
  { value: 'jit.request', label: 'Access requests', help: 'Someone asks for live site access' },
  { value: 'jit.approve', label: 'Approve access', help: 'May approve access from Telegram' },
  { value: 'jit.revoke', label: 'Revoke access', help: 'May revoke access from Telegram' },
];

export default function TelegramPage() {
  const toast = useToast();
  const bindings = useApi<TelegramAuthorizationDto[]>('/telegram/authorizations');
  const [form, setForm] = useState({ bot_id: '', chat_id: '', user_id: '', actions: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = (a: string) => setForm((f) => ({ ...f, actions: f.actions.includes(a) ? f.actions.filter((x) => x !== a) : [...f.actions, a] }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/telegram/authorizations', { method: 'POST', body: form });
      toast.success('Chat connected.');
      setForm({ bot_id: '', chat_id: '', user_id: '', actions: [] });
      await bindings.reload();
    } catch (err) {
      toast.error(errMsg(err, 'Could not connect the chat.'));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    try {
      await apiFetch(`/telegram/authorizations/${id}`, { method: 'DELETE' });
      toast.success('Chat disconnected.');
      await bindings.reload();
    } catch (err) {
      toast.error(errMsg(err, 'Could not disconnect the chat.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Alert routing" description="Chats allowed to receive alerts about critical findings and to act on access requests. Site owners and admins are alerted about failed scans separately, from their own profile." />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Panel flush>
          {bindings.error && <p className="p-5 text-sm text-critical">{bindings.error}</p>}
          {!bindings.error && bindings.data === null && <SkeletonRows count={3} />}
          {bindings.data?.length === 0 && (
            <EmptyState icon={<BellRinging size={20} />} title="No chats connected">
              Connect a chat on the right to send critical-finding alerts or take access decisions from Telegram.
            </EmptyState>
          )}
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {bindings.data?.map((b) => (
                <motion.li key={b.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[13px] font-medium">chat {b.chat_id}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {b.actions.map((a) => (
                        <Badge key={a}>{EVENTS.find((e) => e.value === a)?.label ?? a}</Badge>
                      ))}
                    </div>
                  </div>
                  {b.revoked_at ? (
                    <Badge>Disconnected</Badge>
                  ) : (
                    <Button variant="danger" size="sm" loading={busy === b.id} onClick={() => revoke(b.id)}>
                      Disconnect
                    </Button>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </Panel>

        <Panel className="lg:sticky lg:top-24">
          <form onSubmit={create} className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-tight">Connect a chat</h2>
            <Field label="Bot" htmlFor="tg-bot">
              <Input id="tg-bot" value={form.bot_id} onChange={(e) => setForm((f) => ({ ...f, bot_id: e.target.value }))} required />
            </Field>
            <Field label="Chat id" htmlFor="tg-chat">
              <Input id="tg-chat" className="font-mono" value={form.chat_id} onChange={(e) => setForm((f) => ({ ...f, chat_id: e.target.value }))} required />
            </Field>
            <Field label="Telegram user id" htmlFor="tg-user">
              <Input id="tg-user" className="font-mono" value={form.user_id} onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))} required />
            </Field>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink-dim">What this chat can do</legend>
              <div className="flex flex-col gap-1.5">
                {EVENTS.map((ev) => {
                  const on = form.actions.includes(ev.value);
                  return (
                    <button key={ev.value} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(ev.value)} className={cn('flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-left outline-none ring-1 ring-inset transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent/70', on ? 'bg-accent/[0.08] ring-accent/30' : 'bg-sunken ring-line hover:ring-line-strong')}>
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-[5px] ring-1 ring-inset transition-colors', on ? 'bg-accent text-on-accent ring-accent' : 'ring-line-strong')}>{on && <Check size={12} weight="bold" />}</span>
                      <span>
                        <span className="block text-[13px] font-medium">{ev.label}</span>
                        <span className="block text-xs text-ink-faint">{ev.help}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <Button type="submit" variant="primary" icon={<Plus size={16} />} loading={saving} disabled={form.actions.length === 0} className="w-full">
              Connect chat
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

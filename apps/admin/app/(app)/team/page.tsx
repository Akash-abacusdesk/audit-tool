'use client';

import { useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { BellRinging, BellSlash, Check, UserPlus, UsersThree } from '@phosphor-icons/react';
import type { TeamMemberDto } from '@platform/shared';
import { apiFetch } from '../../../lib/api';
import { useOverview } from '../../../lib/OverviewContext';
import { errMsg, useApi } from '../../../lib/useApi';
import { Avatar, Badge, Button, EmptyState, Field, Input, PageHeader, Panel, SkeletonRows, spring, useToast } from '../../../components/ui';

const ROLE_LABEL: Record<string, string> = { manager: 'Admin', security_admin: 'Security admin', team_lead: 'Team lead', developer: 'Developer', project_coordinator: 'Coordinator' };

export default function TeamPage() {
  const toast = useToast();
  const { refresh: refreshOverview } = useOverview();
  const team = useApi<TeamMemberDto[]>('/team-members');
  const [form, setForm] = useState({ displayName: '', email: '', password: '', telegramChatId: '' });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/team-members', { method: 'POST', body: { displayName: form.displayName, email: form.email, password: form.password, ...(form.telegramChatId ? { telegramChatId: form.telegramChatId } : {}) } });
      toast.success(`${form.displayName} was added to the team.`);
      setForm({ displayName: '', email: '', password: '', telegramChatId: '' });
      await Promise.all([team.reload(), refreshOverview()]);
    } catch (err) {
      toast.error(errMsg(err, 'Could not add the team member.'));
    } finally {
      setSaving(false);
    }
  }

  async function saveChat(m: TeamMemberDto) {
    setSavingId(m.id);
    try {
      const v = (editing[m.id] ?? '').trim();
      await apiFetch(`/team-members/${m.id}`, { method: 'PATCH', body: { telegramChatId: v === '' ? null : v } });
      setEditing(({ [m.id]: _drop, ...rest }) => rest);
      toast.success(v === '' ? `Alerts are off for ${m.displayName}.` : `${m.displayName} will get alerts on Telegram.`);
      await team.reload();
    } catch (err) {
      toast.error(errMsg(err, 'Could not save the chat id.'));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <PageHeader title="Team" description="The people who run your sites. Their Telegram chat gets the alert when a scan on one of their sites fails." />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Panel flush>
          {team.error && <p className="p-5 text-sm text-critical">{team.error}</p>}
          {!team.error && team.data === null && <SkeletonRows count={4} />}
          {team.data?.length === 0 && (
            <EmptyState icon={<UsersThree size={20} />} title="No team members yet">
              Add the first person on the right, then assign them to a site.
            </EmptyState>
          )}
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {team.data?.map((m) => {
                const draft = editing[m.id];
                const dirty = draft !== undefined && draft.trim() !== (m.telegramChatId ?? '');
                return (
                  <motion.li key={m.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="px-5 py-4">
                    <div className="flex items-start gap-3.5">
                      <Avatar name={m.displayName} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-medium tracking-tight">{m.displayName}</span>
                          {m.roles.map((r) => (
                            <Badge key={r} tone="info">
                              {ROLE_LABEL[r] ?? r}
                            </Badge>
                          ))}
                          {!m.isActive && <Badge>Inactive</Badge>}
                        </div>
                        <div className="truncate text-xs text-ink-faint">
                          {m.email}
                          {m.sites.length > 0 ? `, runs ${m.sites.map((s) => s.name).join(', ')}` : ', no sites assigned'}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <span className={m.telegramChatId ? 'text-accent' : 'text-medium'} title={m.telegramChatId ? 'Receives alerts' : 'No alerts'}>
                            {m.telegramChatId ? <BellRinging size={18} /> : <BellSlash size={18} />}
                          </span>
                          <Input
                            aria-label={`Telegram chat id for ${m.displayName}`}
                            placeholder="Telegram chat id"
                            value={draft ?? m.telegramChatId ?? ''}
                            onChange={(e) => setEditing((s) => ({ ...s, [m.id]: e.target.value }))}
                            className="!h-8 max-w-56 font-mono !text-[13px]"
                          />
                          <AnimatePresence>
                            {dirty && (
                              <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
                                <Button size="sm" variant="secondary" icon={<Check size={16} />} loading={savingId === m.id} onClick={() => saveChat(m)}>
                                  Save
                                </Button>
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </Panel>

        <Panel className="lg:sticky lg:top-24">
          <form onSubmit={create} className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Add a team member</h2>
              <p className="mt-0.5 text-xs leading-5 text-ink-faint">They can sign in and see the sites they are assigned to.</p>
            </div>
            <Field label="Name" htmlFor="tm-name">
              <Input id="tm-name" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} required />
            </Field>
            <Field label="Email" htmlFor="tm-email">
              <Input id="tm-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
            </Field>
            <Field label="Initial password" htmlFor="tm-pass" hint="At least 12 characters. They can change it after signing in.">
              <Input id="tm-pass" type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
            </Field>
            <Field label="Telegram chat id" htmlFor="tm-chat" hint="They must open the alerts bot and press Start first, or Telegram will not deliver. Their id is shown by @userinfobot.">
              <Input id="tm-chat" placeholder="123456789" className="font-mono" value={form.telegramChatId} onChange={(e) => setForm((f) => ({ ...f, telegramChatId: e.target.value }))} />
            </Field>
            <Button type="submit" variant="primary" icon={<UserPlus size={16} />} loading={saving} className="mt-1 w-full">
              Add team member
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

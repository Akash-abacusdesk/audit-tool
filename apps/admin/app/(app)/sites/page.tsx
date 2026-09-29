'use client';

import { useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { GlobeHemisphereWest, PaperPlaneTilt, Pause, Play, Plus, WarningCircle } from '@phosphor-icons/react';
import type { SiteDto, TeamMemberDto } from '@platform/shared';
import { apiFetch } from '../../../lib/api';
import { useMeContext } from '../../../lib/MeContext';
import { useOverview } from '../../../lib/OverviewContext';
import { errMsg, useApi } from '../../../lib/useApi';
import { Avatar, Badge, Button, EmptyState, Field, Input, PageHeader, Panel, Select, SkeletonRows, spring, useToast, type Tone } from '../../../components/ui';

function health(s: SiteDto): { tone: Tone; label: string } {
  if (!s.lastScan) return { tone: 'neutral', label: 'No scans yet' };
  if (s.lastScan.status === 'failed') return { tone: 'critical', label: 'Scan failed' };
  if (s.lastScan.status === 'partial') return { tone: 'medium', label: 'Scan incomplete' };
  return { tone: 'accent', label: 'Healthy' };
}

export default function SitesPage() {
  const me = useMeContext();
  const toast = useToast();
  const { refresh: refreshOverview } = useOverview();
  const orgId = me.bindings[0]?.orgId ?? '';
  const sites = useApi<SiteDto[]>('/sites');
  const members = useApi<TeamMemberDto[]>('/team-members');
  const team = (members.data ?? []).filter((m) => m.isActive);
  const [form, setForm] = useState({ name: '', url: '', ownerUserId: '' });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadAll = async () => {
    await Promise.all([sites.reload(), members.reload(), refreshOverview()]);
  };

  async function act(key: string, fn: () => Promise<string | void>, fallback: string) {
    setBusy(key);
    try {
      const done = await fn();
      await reloadAll();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(errMsg(e, fallback));
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch('/sites', { method: 'POST', body: { orgId, name: form.name, ...(form.url ? { url: form.url } : {}), ...(form.ownerUserId ? { ownerUserId: form.ownerUserId } : {}) } });
      toast.success(`${form.name} is registered.`);
      setForm({ name: '', url: '', ownerUserId: '' });
      await reloadAll();
    } catch (err) {
      toast.error(errMsg(err, 'Could not add the site.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="Sites" description="Every site has one team member who runs it. When a scan fails, they and the admins are alerted on Telegram and a task is created for them." />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Panel flush>
          {sites.error && <p className="p-5 text-sm text-critical">{sites.error}</p>}
          {!sites.error && sites.data === null && <SkeletonRows count={4} />}
          {sites.data?.length === 0 && (
            <EmptyState icon={<GlobeHemisphereWest size={20} />} title="No sites yet">
              Register your first site on the right. Add a team member first if you want to assign someone to it.
            </EmptyState>
          )}
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {sites.data?.map((s) => {
                const h = health(s);
                return (
                  <motion.li key={s.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-medium tracking-tight">{s.name}</span>
                          {s.status === 'paused' && <Badge>Paused</Badge>}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-faint">{s.url ?? 'No URL set'}</div>
                      </div>
                      <Badge tone={h.tone} dot>
                        {h.label}
                      </Badge>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-faint">
                      <span>
                        <span className="tabular-nums text-ink-dim">{s.openFindings}</span> open finding{s.openFindings === 1 ? '' : 's'}
                      </span>
                      <span>
                        <span className="tabular-nums text-ink-dim">{s.tasks}</span> task{s.tasks === 1 ? '' : 's'}
                      </span>
                      {s.lastScan && (
                        <span>
                          {s.lastScan.tool}, {new Date(s.lastScan.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>

                    <div className="mt-3.5 flex flex-wrap items-center gap-2">
                      {s.owner ? <Avatar name={s.owner.displayName} size="sm" /> : <span className="flex size-7 items-center justify-center rounded-[10px] bg-medium/10 text-medium ring-1 ring-inset ring-medium/25"><WarningCircle size={14} /></span>}
                      <Select aria-label={`Team member handling ${s.name}`} value={s.owner?.id ?? ''} disabled={busy === `own-${s.id}`} onChange={(e) => act(`own-${s.id}`, () => apiFetch(`/sites/${s.id}`, { method: 'PATCH', body: { ownerUserId: e.target.value || null } }).then(() => 'Owner updated.'), 'Could not change the owner.')} className="!h-8 !w-48 !text-[13px]">
                        <option value="">Unassigned</option>
                        {team.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </Select>
                      {s.owner && !s.owner.telegramChatId && <span className="text-xs text-medium">No Telegram chat id, so no alerts</span>}
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" icon={<PaperPlaneTilt size={16} />} loading={busy === `test-${s.id}`} onClick={() => act(`test-${s.id}`, async () => {
                        const r = await apiFetch<{ recipients: number }>(`/sites/${s.id}/test-alert`, { method: 'POST', body: {} });
                        return r.recipients === 0 ? 'No one to alert yet. Add a Telegram chat id to the owner or an admin.' : `Test alert sent to ${r.recipients} chat${r.recipients === 1 ? '' : 's'}.`;
                      }, 'Could not send the test alert.')}>
                        Test alert
                      </Button>
                      <Button size="sm" variant="ghost" icon={s.status === 'active' ? <Pause size={16} /> : <Play size={16} />} loading={busy === `pause-${s.id}`} onClick={() => act(`pause-${s.id}`, () => apiFetch(`/sites/${s.id}`, { method: 'PATCH', body: { status: s.status === 'active' ? 'paused' : 'active' } }).then(() => (s.status === 'active' ? 'Site paused. Alerts are off.' : 'Site resumed.')), 'Could not update the site.')}>
                        {s.status === 'active' ? 'Pause' : 'Resume'}
                      </Button>
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
              <h2 className="text-sm font-semibold tracking-tight">Register a site</h2>
              <p className="mt-0.5 text-xs leading-5 text-ink-faint">Creates the site with a production environment and gives its owner access to it.</p>
            </div>
            <Field label="Name" htmlFor="site-name">
              <Input id="site-name" placeholder="Northwind Storefront" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
            </Field>
            <Field label="URL" htmlFor="site-url">
              <Input id="site-url" type="url" placeholder="https://shop.northwind.example" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
            </Field>
            <Field label="Handled by" htmlFor="site-owner" hint={team.length === 0 ? 'No team members yet. Add one on the Team page.' : undefined}>
              <Select id="site-owner" value={form.ownerUserId} onChange={(e) => setForm((f) => ({ ...f, ownerUserId: e.target.value }))}>
                <option value="">Assign later</option>
                {team.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="primary" icon={<Plus size={16} />} loading={saving} disabled={!orgId} className="mt-1 w-full">
              Add site
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

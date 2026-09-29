'use client';

import Link from 'next/link';
import * as motion from 'motion/react-m';
import { ArrowRight, ListChecks, LockKey, Binoculars, UsersThree } from '@phosphor-icons/react';
import { useMeContext } from '../../../lib/MeContext';
import { useOverview } from '../../../lib/OverviewContext';
import { cn } from '../../../lib/cn';
import { Badge, CountUp, EmptyState, PageHeader, Panel, RevealGroup, RevealItem, Skeleton, ease, type Tone } from '../../../components/ui';

const SEV: { key: 'critical' | 'high' | 'medium' | 'low' | 'info'; label: string; bar: string; text: string }[] = [
  { key: 'critical', label: 'Critical', bar: 'bg-critical', text: 'text-critical' },
  { key: 'high', label: 'High', bar: 'bg-high', text: 'text-high' },
  { key: 'medium', label: 'Medium', bar: 'bg-medium', text: 'text-medium' },
  { key: 'low', label: 'Low', bar: 'bg-low', text: 'text-low' },
  { key: 'info', label: 'Info', bar: 'bg-info', text: 'text-info' },
];
const SCAN_TONE: Record<string, { tone: Tone; label: string }> = {
  completed: { tone: 'accent', label: 'Completed' },
  failed: { tone: 'critical', label: 'Failed' },
  partial: { tone: 'medium', label: 'Incomplete' },
};

function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1.5 text-[13px] font-medium text-accent outline-none focus-visible:underline">
      {children}
      <ArrowRight size={14} className="transition-transform duration-200 ease-spring group-hover:translate-x-0.5" />
    </Link>
  );
}

function SideStat({ icon, label, value, note, href, alert }: { icon: React.ReactNode; label: string; value: number; note: string; href: string; alert?: boolean }) {
  return (
    <Link href={href} className="group block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
      <Panel className="transition-colors duration-200 group-hover:bg-white/[0.05]">
        <div className="flex items-start justify-between">
          <span className="text-[13px] text-ink-dim">{label}</span>
          <span className="text-ink-faint">{icon}</span>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <CountUp value={value} className={cn('text-3xl font-medium tabular-nums tracking-tight', alert ? 'text-medium' : 'text-ink')} />
        </div>
        <p className="mt-1 text-xs text-ink-faint">{note}</p>
      </Panel>
    </Link>
  );
}

export default function OverviewPage() {
  const me = useMeContext();
  const { data } = useOverview();
  const first = (me.user.displayName || me.user.email).split(' ')[0];
  const total = data ? SEV.reduce((n, s) => n + data.findings[s.key], 0) : 0;

  return (
    <div>
      <PageHeader title={`Good to see you, ${first}`} description="What needs attention across your sites right now." />

      {!data ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-12">
          <Skeleton className="h-64 rounded-2xl lg:col-span-7" />
          <Skeleton className="h-64 rounded-2xl lg:col-span-5" />
          <Skeleton className="h-72 rounded-2xl lg:col-span-8" />
          <Skeleton className="h-72 rounded-2xl lg:col-span-4" />
        </div>
      ) : (
        <RevealGroup className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-12">
          <RevealItem className="lg:col-span-7">
            <Panel className="h-full" coreClassName="flex h-full flex-col p-6">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-ink-dim">Open findings</span>
                <TextLink href="/findings">Review</TextLink>
              </div>
              <div className="mt-4 flex items-end gap-4">
                <CountUp value={total} className="text-6xl font-medium leading-none tabular-nums tracking-tighter" />
                <p className="pb-1.5 text-sm text-ink-dim">
                  {data.findings.critical + data.findings.high > 0 ? (
                    <>
                      <span className="text-critical">{data.findings.critical} critical</span> and <span className="text-high">{data.findings.high} high</span> need a decision.
                    </>
                  ) : (
                    'Nothing critical or high is open.'
                  )}
                </p>
              </div>
              <div className="mt-auto pt-8">
                <motion.div initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.9, ease, delay: 0.15 }} style={{ transformOrigin: 'left' }} className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-sunken">
                  {total === 0 ? null : SEV.filter((s) => data.findings[s.key] > 0).map((s) => <div key={s.key} className={cn('h-full', s.bar)} style={{ flexGrow: data.findings[s.key] }} />)}
                </motion.div>
                <dl className="mt-4 grid grid-cols-5 gap-2">
                  {SEV.map((s) => (
                    <div key={s.key}>
                      <dt className="flex items-center gap-1.5 text-xs text-ink-faint">
                        <span className={cn('size-1.5 rounded-full', s.bar)} />
                        {s.label}
                      </dt>
                      <dd className={cn('text-lg tabular-nums', data.findings[s.key] ? s.text : 'text-ink-faint')}>{data.findings[s.key]}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>
          </RevealItem>

          <RevealItem className="lg:col-span-5">
            <Panel className="h-full" coreClassName="flex h-full flex-col p-6">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-ink-dim">Sites</span>
                <TextLink href="/sites">Manage</TextLink>
              </div>
              <div className="mt-4 flex items-end gap-3">
                <CountUp value={data.sites.total} className="text-6xl font-medium leading-none tabular-nums tracking-tighter" />
                <span className="pb-1.5 text-sm text-ink-dim">registered</span>
              </div>
              <div className="mt-auto flex flex-col gap-2 pt-8">
                <div className="flex items-center justify-between rounded-[10px] bg-sunken px-3.5 py-2.5">
                  <span className="text-[13px] text-ink-dim">Last scan failed</span>
                  <Badge tone={data.sites.failing ? 'critical' : 'neutral'} dot>
                    {data.sites.failing}
                  </Badge>
                </div>
                <div className="flex items-center justify-between rounded-[10px] bg-sunken px-3.5 py-2.5">
                  <span className="text-[13px] text-ink-dim">No team member assigned</span>
                  <Badge tone={data.sites.unassigned ? 'medium' : 'neutral'} dot>
                    {data.sites.unassigned}
                  </Badge>
                </div>
              </div>
            </Panel>
          </RevealItem>

          <RevealItem className="lg:col-span-8">
            <Panel flush className="h-full">
              <div className="flex items-center justify-between px-5 pb-3 pt-4">
                <span className="text-[13px] font-medium text-ink-dim">Latest scans</span>
                <TextLink href="/scans">All scans</TextLink>
              </div>
              {data.recentScans.length === 0 ? (
                <EmptyState icon={<Binoculars size={20} />} title="No scans yet">
                  Scan results appear here as soon as a scanner reports for one of your sites.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-line border-t border-line">
                  {data.recentScans.map((s) => {
                    const t = SCAN_TONE[s.status] ?? { tone: 'neutral' as Tone, label: s.status };
                    return (
                      <li key={`${s.scanId}${s.at}`} className="flex items-center gap-4 px-5 py-3.5">
                        <Badge tone={t.tone} dot className="w-24 justify-center">
                          {t.label}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{s.site}</div>
                          <div className="truncate font-mono text-xs text-ink-faint">
                            {s.tool} · {s.scanId}
                          </div>
                        </div>
                        <time className="shrink-0 text-xs tabular-nums text-ink-faint">{new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </RevealItem>

          <RevealItem className="flex flex-col gap-4 lg:col-span-4">
            <SideStat icon={<ListChecks size={20} />} label="Tasks waiting to send" value={data.tasks.pending + data.tasks.failed} note={data.tasks.failed ? `${data.tasks.failed} failed delivery` : `${data.tasks.sent} already in the task portal`} href="/tasks" alert={data.tasks.failed > 0} />
            <SideStat icon={<LockKey size={20} />} label="Access requests" value={data.access.pendingRequests} note={data.access.pendingRequests ? 'Waiting for your decision' : 'Nothing waiting'} href="/jit" alert={data.access.pendingRequests > 0} />
            <SideStat icon={<UsersThree size={20} />} label="Team members" value={data.team.active} note="Active accounts" href="/team" />
          </RevealItem>
        </RevealGroup>
      )}
    </div>
  );
}

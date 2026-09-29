'use client';

import { useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { Check, Copy, LockKey, ShieldSlash, X } from '@phosphor-icons/react';
import { apiFetch } from '../../../lib/api';
import { useOverview } from '../../../lib/OverviewContext';
import { errMsg, useApi } from '../../../lib/useApi';
import { Badge, Button, EmptyState, PageHeader, Panel, SkeletonRows, spring, useToast } from '../../../components/ui';

interface JitRequest { id: string; site_id: string; reason: string; duration_minutes: number; status: 'pending' | 'approved' | 'rejected'; created_at: string }
interface JitGrant { grant_id: string; ttl_seconds: number; requester: string; site_id: string; status: 'active' | 'revoked' | 'expired'; issued_at: string; expires_at: string }

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function JitPage() {
  const toast = useToast();
  const { refresh: refreshOverview } = useOverview();
  const requests = useApi<JitRequest[]>('/jit/requests');
  const grants = useApi<JitGrant[]>('/jit/grants');
  const [issued, setIssued] = useState<{ requestId: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = requests.data?.filter((r) => r.status === 'pending') ?? null;
  const active = grants.data?.filter((g) => g.status === 'active') ?? null;

  async function act(key: string, fn: () => Promise<string>, fallback: string) {
    setBusy(key);
    try {
      toast.success(await fn());
      await Promise.all([requests.reload(), grants.reload(), refreshOverview()]);
    } catch (e) {
      toast.error(errMsg(e, fallback));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Access requests" description="Time-limited administrator access to a live site. Approve, reject, or revoke it at any time." />

      {(requests.error || grants.error) && <p className="mb-6 rounded-[10px] bg-critical/[0.07] px-4 py-3 text-sm text-critical ring-1 ring-inset ring-critical/20">{requests.error ?? grants.error}</p>}

      <AnimatePresence>
        {issued && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={spring} className="mb-6">
            <Panel>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold tracking-tight">One-time access code</h2>
                  <p className="mt-0.5 text-xs leading-5 text-ink-faint">Give this to the person who asked. It is shown once and works once.</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                  Done
                </Button>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-[10px] bg-sunken px-3.5 py-2.5 font-mono text-[13px] text-accent ring-1 ring-inset ring-line">{issued.token}</code>
                <Button
                  variant="secondary"
                  icon={copied ? <Check size={16} /> : <Copy size={16} />}
                  onClick={async () => {
                    await navigator.clipboard.writeText(issued.token);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-8">
        <section aria-labelledby="pending-h">
          <div className="mb-3 flex items-center gap-2.5">
            <h2 id="pending-h" className="text-sm font-semibold tracking-tight">
              Waiting for a decision
            </h2>
            {pending && pending.length > 0 && <Badge tone="medium">{pending.length}</Badge>}
          </div>
          <Panel flush>
            {pending === null && !requests.error && <SkeletonRows count={2} />}
            {pending?.length === 0 && <EmptyState icon={<LockKey size={20} />} title="Nothing waiting">New requests appear here the moment someone asks for access.</EmptyState>}
            <ul className="divide-y divide-line">
              <AnimatePresence initial={false}>
                {pending?.map((r) => (
                  <motion.li key={r.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13px] font-medium">{r.site_id}</div>
                      <div className="mt-0.5 text-sm text-ink-dim">{r.reason}</div>
                      <div className="mt-0.5 text-xs text-ink-faint">
                        {r.duration_minutes} minutes, asked {when(r.created_at)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" icon={<Check size={16} />} loading={busy === `a-${r.id}`} onClick={() => act(`a-${r.id}`, async () => {
                        const res = await apiFetch<{ request_id: string; token: string }>(`/jit/requests/${r.id}/approve`, { method: 'POST' });
                        setIssued({ requestId: res.request_id, token: res.token });
                        return 'Approved. Copy the access code below.';
                      }, 'Could not approve the request.')}>
                        Approve
                      </Button>
                      <Button variant="danger" size="sm" icon={<X size={16} />} loading={busy === `r-${r.id}`} onClick={() => act(`r-${r.id}`, async () => {
                        await apiFetch(`/jit/requests/${r.id}/reject`, { method: 'POST' });
                        return 'Request rejected.';
                      }, 'Could not reject the request.')}>
                        Reject
                      </Button>
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </Panel>
        </section>

        <section aria-labelledby="active-h">
          <div className="mb-3 flex items-center gap-2.5">
            <h2 id="active-h" className="text-sm font-semibold tracking-tight">
              Access in use
            </h2>
            {active && active.length > 0 && <Badge tone="accent">{active.length}</Badge>}
          </div>
          <Panel flush>
            {active === null && !grants.error && <SkeletonRows count={2} />}
            {active?.length === 0 && <EmptyState icon={<ShieldSlash size={20} />} title="No one has live access">Approved access that has been redeemed shows here until it expires.</EmptyState>}
            <ul className="divide-y divide-line">
              <AnimatePresence initial={false}>
                {active?.map((g) => (
                  <motion.li key={g.grant_id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13px] font-medium">{g.site_id}</div>
                      <div className="mt-0.5 text-xs text-ink-faint">Expires {when(g.expires_at)}</div>
                    </div>
                    <Button variant="danger" size="sm" loading={busy === `v-${g.grant_id}`} onClick={() => act(`v-${g.grant_id}`, async () => {
                      await apiFetch(`/jit/grants/${g.grant_id}/revoke`, { method: 'POST' });
                      return 'Access revoked.';
                    }, 'Could not revoke access.')}>
                      Revoke now
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </Panel>
        </section>
      </div>
    </div>
  );
}

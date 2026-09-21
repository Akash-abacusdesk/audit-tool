'use client';

import { useEffect, useCallback, useState } from 'react';
import { useSession, canAnywhere } from '@/lib/auth';
import { Topbar } from '@/components/shell/topbar';
import { PageHeader, AccessDenied, ErrorState, EmptyState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/form';
import { Table, Th, Td, Tr } from '@/components/ui/table';
import { fmtDateTime, shortId } from '@/lib/format';
import {
  createJitRequest,
  approveJitRequest,
  rejectJitRequest,
  redeemJit,
  revokeJitGrant,
  listJitRequests,
  listJitGrants,
  DURATION_OPTIONS,
} from '@/lib/jit';
import type { JitRequestInput, JitRequestDto, JitGrantDto } from '@platform/shared';

function toReqRow(d: JitRequestDto): ReqRow {
  return {
    requestId: d.id,
    siteId: d.site_id,
    reason: d.reason,
    durationMinutes: d.duration_minutes,
    status: d.status,
  };
}
function toGrantRow(g: JitGrantDto): GrantRow {
  return {
    grantId: g.grant_id,
    ttlSeconds: g.ttl_seconds,
    requester: g.requester ?? '',
    siteId: g.site_id,
    status: g.status,
  };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'request failed';
}

type Tab = 'request' | 'approvals' | 'grants';

interface ReqRow {
  requestId: string;
  siteId: string;
  reason: string;
  durationMinutes: number;
  status: string;
  redemptionCode?: string;
  grantId?: string;
}
interface GrantRow {
  grantId: string;
  ttlSeconds: number;
  requester: string;
  siteId: string;
  status: string;
}

const REQ_STATUS_CLASS: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-600 ring-amber-500/25',
  approved: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/25',
  rejected: 'bg-destructive/10 text-destructive ring-destructive/25',
  expired: 'bg-muted text-muted-foreground ring-border',
};
const GRANT_STATUS_CLASS: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/25',
  consumed: 'bg-muted text-muted-foreground ring-border',
  revoked: 'bg-destructive/10 text-destructive ring-destructive/25',
  expired: 'bg-muted text-muted-foreground ring-border',
};

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function JitPage() {
  const { me } = useSession();
  if (!canAnywhere(me, 'jit.request')) return <AccessDenied permission="jit.request" />;
  return (
    <>
      <Topbar trail={['Just-in-time access']} />
      <main className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
        <PageHeader
          title="Just-in-time access"
          description="Request time-boxed privileged access to a WordPress site, act on pending requests, and manage the one-time redemption grants. The raw token is shown once at approval — relay it to the WordPress plugin, which redeems it for a short-lived grant."
        />
        <JitTabs me={me} />
      </main>
    </>
  );
}

function JitTabs({ me }: { me: ReturnType<typeof useSession>['me'] }) {
  const [tab, setTab] = useState<Tab>('request');
  const [requests, setRequests] = useState<ReqRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canApprove = canAnywhere(me, 'jit.approve');
  const canRevoke = canAnywhere(me, 'jit.revoke');

  const reloadRequests = useCallback(async () => {
    try {
      setRequests((await listJitRequests('pending')).map(toReqRow));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  const reloadGrants = useCallback(async () => {
    try {
      setGrants((await listJitGrants()).map(toGrantRow));
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void reloadRequests();
    void reloadGrants();
  }, [reloadRequests, reloadGrants]);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'request', label: 'Request access' },
    { id: 'approvals', label: 'Approvals' },
    { id: 'grants', label: 'My grants' },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`h-8 rounded-lg px-3 text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error ? <ErrorState code="JIT_ERROR" message={error} /> : null}
      {tab === 'request' ? (
        <RequestForm onRequested={reloadRequests} onError={setError} />
      ) : null}
      {tab === 'approvals' ? (
        <ApprovalsTab rows={requests} canApprove={canApprove} onChanged={reloadRequests} onError={setError} />
      ) : null}
      {tab === 'grants' ? (
        <GrantsTab rows={grants} canRevoke={canRevoke} onChanged={reloadGrants} onError={setError} />
      ) : null}
    </section>
  );
}

function RequestForm({
  onRequested,
  onError,
}: {
  onRequested: () => void;
  onError: (m: string | null) => void;
}) {
  const [siteId, setSiteId] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<number>(30);
  const [orgId, setOrgId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    if (!siteId.trim() || !reason.trim()) {
      onError('Site ID and reason are required.');
      return;
    }
    const input: JitRequestInput = {
      site_id: siteId.trim(),
      reason: reason.trim(),
      duration_minutes: duration,
      ...(orgId.trim()
        ? {
            scope: {
              orgId: orgId.trim(),
              ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
              ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
            },
          }
        : {}),
    };
    setBusy(true);
    try {
      await createJitRequest(input);
      onRequested();
      setSiteId('');
      setReason('');
      setOrgId('');
      setProjectId('');
      setEnvironmentId('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
      <Field label="Site ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="wp-engineering-01" />
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Reason</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-primary"
          placeholder="Why is time-boxed admin access needed?"
        />
      </label>
      <Select label="Duration (minutes)" value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))}>
        {DURATION_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Org ID (uuid)" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="optional" />
        <Field label="Project ID (uuid)" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="optional" />
        <Field label="Environment ID (uuid)" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} placeholder="optional" />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? 'Submitting…' : 'Request access'}
      </Button>
    </form>
  );
}

function ApprovalsTab({
  rows,
  canApprove,
  onChanged,
  onError,
}: {
  rows: ReqRow[];
  canApprove: boolean;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [manualId, setManualId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ code: string; site: string } | null>(null);

  async function act(id: string, kind: 'approve' | 'reject') {
    onError(null);
    setBusyId(id);
    try {
      if (kind === 'approve') {
        const res = await approveJitRequest(id);
        setRevealed({ code: res.redemption_code, site: rows.find((x) => x.requestId === id)?.siteId ?? '' });
      } else {
        await rejectJitRequest(id);
      }
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusyId(null);
    }
  }

  if (!canApprove) {
    return (
      <EmptyState
        title="Approve access"
        description="Your role does not include jit.approve. Requests can only be approved by a team lead, manager, or security admin."
      />
    );
  }

  return (
    <div className="space-y-4">
      {revealed ? (
        <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 shadow-xs">
          <p className="text-sm font-medium text-foreground">One-time redemption code (shown once)</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Relay this to the WordPress plugin for site <span className="font-mono">{revealed.site}</span>. It cannot be
            retrieved again.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-card px-3 py-2 font-mono text-xs">{revealed.code}</code>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (manualId.trim()) void act(manualId.trim(), 'approve');
        }}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4 shadow-xs"
      >
        <Field
          label="Act on request ID"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder="paste a request id"
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={!manualId.trim()}>
          Approve
        </Button>
        <Button type="button" variant="ghost" disabled={!manualId.trim()} onClick={() => void act(manualId.trim(), 'reject')}>
          Reject
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No pending requests" description="Pending JIT requests across the org appear here for approval. Submit one from the Request tab or paste an ID above to act on a specific request." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Request</Th>
              <Th>Site</Th>
              <Th>Reason</Th>
              <Th>Duration</Th>
              <Th>Status</Th>
              <Th>Redemption code</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.requestId}>
                <Td className="font-mono">{shortId(r.requestId)}</Td>
                <Td>{r.siteId}</Td>
                <Td className="max-w-xs truncate">{r.reason}</Td>
                <Td>{r.durationMinutes}m</Td>
                <Td>
                  <Badge dot className={REQ_STATUS_CLASS[r.status] ?? 'bg-muted text-muted-foreground ring-border'}>
                    {r.status}
                  </Badge>
                </Td>
                <Td className="max-w-[14rem]">
                  {r.redemptionCode ? (
                    <code className="block truncate font-mono text-xs" title={r.redemptionCode}>
                      {r.redemptionCode}
                    </code>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Td>
                <Td>
                  {r.status === 'pending' ? (
                    <div className="flex gap-1.5">
                      <Button variant="outline" className="h-7 px-2 text-xs" disabled={busyId === r.requestId} onClick={() => void act(r.requestId, 'approve')}>
                        Approve
                      </Button>
                      <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busyId === r.requestId} onClick={() => void act(r.requestId, 'reject')}>
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">closed</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function GrantsTab({
  rows,
  canRevoke,
  onChanged,
  onError,
}: {
  rows: GrantRow[];
  canRevoke: boolean;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [manualGrant, setManualGrant] = useState('');
  const [redeemId, setRedeemId] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function revoke(id: string) {
    onError(null);
    setBusy(true);
    try {
      await revokeJitGrant(id);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'revoke failed');
    } finally {
      setBusy(false);
    }
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    if (!redeemId.trim() || !redeemCode.trim()) {
      onError('Request ID and redemption code are required to redeem.');
      return;
    }
    setBusy(true);
    try {
      const tokenHash = await sha256Hex(redeemCode.trim());
      await redeemJit({ request_id: redeemId.trim(), token_hash: tokenHash });
      onChanged();
      setRedeemId('');
      setRedeemCode('');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'redeem failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={redeem} className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
        <p className="text-xs font-medium text-muted-foreground">Redeem a token (WordPress-side flow)</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Request ID" value={redeemId} onChange={(e) => setRedeemId(e.target.value)} placeholder="request id" />
          <Field label="Redemption code" value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} placeholder="token from approval" />
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Redeeming…' : 'Redeem token'}
        </Button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (manualGrant.trim()) void revoke(manualGrant.trim());
        }}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card p-4 shadow-xs"
      >
        <Field label="Revoke grant ID" value={manualGrant} onChange={(e) => setManualGrant(e.target.value)} placeholder="paste a grant id" className="flex-1" />
        <Button type="submit" variant="destructive" disabled={!manualGrant.trim() || !canRevoke}>
          Revoke
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState title="No grants" description="Grants minted by redeeming a token (or created elsewhere) appear here. Revoke an active grant by pasting its ID above." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Grant</Th>
              <Th>Site</Th>
              <Th>Requester</Th>
              <Th>TTL</Th>
              <Th>Status</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <Tr key={g.grantId}>
                <Td className="font-mono">{shortId(g.grantId)}</Td>
                <Td>{g.siteId}</Td>
                <Td className="font-mono">{shortId(g.requester)}</Td>
                <Td>{g.ttlSeconds}s</Td>
                <Td>
                  <Badge dot className={GRANT_STATUS_CLASS[g.status] ?? 'bg-muted text-muted-foreground ring-border'}>
                    {g.status}
                  </Badge>
                </Td>
                <Td>
                  {g.status === 'active' && canRevoke ? (
                    <Button variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void revoke(g.grantId)}>
                      Revoke
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{canRevoke ? 'closed' : 'no jit.revoke'}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

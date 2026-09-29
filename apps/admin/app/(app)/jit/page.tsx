'use client';

import { useEffect, useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { apiFetch, ApiRequestError } from '../../../lib/api';
import { PageHeader } from '../../../components/PageHeader';

interface JitRequest {
  id: string;
  site_id: string;
  reason: string;
  duration_minutes: number;
  status: 'pending' | 'approved' | 'rejected';
  created_by: string;
  created_at: string;
  expires_at: string | null;
  approved_at: string | null;
}

interface JitGrant {
  grant_id: string;
  ttl_seconds: number;
  requester: string;
  site_id: string;
  status: 'active' | 'revoked' | 'expired';
  issued_at: string;
  expires_at: string;
}

export default function JitPage() {
  const [requests, setRequests] = useState<JitRequest[] | null>(null);
  const [grants, setGrants] = useState<JitGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ requestId: string; token: string } | null>(null);

  async function refresh() {
    try {
      const [r, g] = await Promise.all([
        apiFetch<JitRequest[]>('/jit/requests'),
        apiFetch<JitGrant[]>('/jit/grants'),
      ]);
      setRequests(r);
      setGrants(g);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'failed to load JIT data');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function approve(id: string) {
    try {
      const res = await apiFetch<{ request_id: string; token: string }>(`/jit/requests/${id}/approve`, { method: 'POST' });
      setIssuedToken({ requestId: res.request_id, token: res.token });
      refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'approve failed');
    }
  }

  async function reject(id: string) {
    try {
      await apiFetch(`/jit/requests/${id}/reject`, { method: 'POST' });
      refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'reject failed');
    }
  }

  async function revoke(grantId: string) {
    try {
      await apiFetch(`/jit/grants/${grantId}/revoke`, { method: 'POST' });
      refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'revoke failed');
    }
  }

  return (
    <div>
      <PageHeader title="Just-in-Time Access" subtitle="Approve, reject, and revoke temporary privileged sessions." />
      {error && <p className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}

      <AnimatePresence>
        {issuedToken && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="surface mb-4 overflow-hidden p-4"
          >
            <div className="label mb-1.5">One-time redemption token — shown once</div>
            <code className="block break-all rounded-lg bg-black/30 p-2.5 text-xs">{issuedToken.token}</code>
            <button className="btn-ghost mt-3" onClick={() => setIssuedToken(null)}>
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <h2 className="label mb-2.5">Pending Requests</h2>
      <div className="surface mb-6 divide-y divide-[var(--color-border)] overflow-hidden">
        {requests?.filter((r) => r.status === 'pending').length === 0 && (
          <p className="p-4 text-sm text-[var(--color-text-dim)]">No pending requests.</p>
        )}
        {requests?.filter((r) => r.status === 'pending').map((r) => (
          <motion.div
            key={r.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="row-hover flex items-center gap-3 px-4 py-3.5"
          >
            <div className="flex-1">
              <div className="text-sm font-medium">{r.site_id}</div>
              <div className="text-xs text-[var(--color-text-dim)]">{r.reason} · {r.duration_minutes}min</div>
            </div>
            <button className="btn-primary" onClick={() => approve(r.id)}>Approve</button>
            <button className="btn-danger" onClick={() => reject(r.id)}>Reject</button>
          </motion.div>
        ))}
      </div>

      <h2 className="label mb-2.5">Active Grants</h2>
      <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
        {grants?.filter((g) => g.status === 'active').length === 0 && (
          <p className="p-4 text-sm text-[var(--color-text-dim)]">No active grants.</p>
        )}
        {grants?.filter((g) => g.status === 'active').map((g) => (
          <motion.div
            key={g.grant_id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="row-hover flex items-center gap-3 px-4 py-3.5"
          >
            <div className="flex-1">
              <div className="text-sm font-medium">{g.site_id}</div>
              <div className="text-xs text-[var(--color-text-dim)]">expires {new Date(g.expires_at).toLocaleString()}</div>
            </div>
            <button className="btn-danger" onClick={() => revoke(g.grant_id)}>Revoke</button>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

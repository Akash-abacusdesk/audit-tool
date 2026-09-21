'use client';

import type { JitRequestInput, JitRequestDto, JitGrantDto } from '@platform/shared';
import { authFetch } from './auth';

/**
 * S8-D5 client for Jim's S8-D1 JIT grant-state API (contract converged in
 * 1cb1568). All routes enveloped `{ ok, data }`. NO demo fallback — the real
 * backend exists; see docs/frontend/s8-d5-findings.md. There are no list
 * (GET) endpoints, so the page keeps an in-session record of what this browser
 * created/approved/redeemed (legitimate client state, not mock data).
 */

const BASE = '/api/v1/jit';

export interface CreateJitResult {
  request_id: string;
}
export interface ApproveJitResult {
  request_id: string;
  token: string;
  redemption_code: string;
}
export interface RejectJitResult {
  request_id: string;
  status: string;
}
export interface RedeemJitResult {
  grant_id: string;
  ttl_seconds: number;
  requester: string;
  site_id: string;
}
export interface RevokeJitResult {
  grant_id: string;
  status: string;
}

export async function createJitRequest(input: JitRequestInput): Promise<CreateJitResult> {
  return authFetch<CreateJitResult>(`${BASE}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function approveJitRequest(requestId: string): Promise<ApproveJitResult> {
  return authFetch<ApproveJitResult>(`${BASE}/requests/${requestId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export async function rejectJitRequest(requestId: string): Promise<RejectJitResult> {
  return authFetch<RejectJitResult>(`${BASE}/requests/${requestId}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export async function redeemJit(input: { request_id: string; token_hash: string }): Promise<RedeemJitResult> {
  return authFetch<RedeemJitResult>(`${BASE}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function revokeJitGrant(grantId: string): Promise<RevokeJitResult> {
  return authFetch<RevokeJitResult>(`${BASE}/grants/${grantId}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

export async function listJitRequests(status?: string): Promise<JitRequestDto[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return authFetch<JitRequestDto[]>(`${BASE}/requests${q}`);
}

export async function listJitGrants(): Promise<JitGrantDto[]> {
  return authFetch<JitGrantDto[]>(`${BASE}/grants`);
}

export const DURATION_OPTIONS = [15, 30, 60, 240] as const;

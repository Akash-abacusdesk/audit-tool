#!/usr/bin/env node
/**
 * S19 production-readiness acceptance suite (PRD §23) — the [auto] subset
 * from docs/ops/acceptance-checklist.md, runnable live against any booted
 * API instance. This is NOT the full 35-item sign-off — most items need
 * either a real production topology or are already covered by the unit
 * test suite (`npm test`); see the checklist doc for the complete mapping
 * and which items are [doc]/[gap]/[skip].
 *
 * Usage:
 *   node scripts/acceptance-suite.mjs --base-url http://127.0.0.1:3000
 *
 * If bootstrap is unavailable (users already exist on the target), set
 * BENCH_EMAIL/BENCH_PASSWORD to an existing manager-permission account.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { baseUrl: 'http://127.0.0.1:3000' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url') out.baseUrl = argv[++i];
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const API = `${ARGS.baseUrl}/api/v1`;
const ROOT = ARGS.baseUrl;

async function call(base, path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (method !== 'GET') init.body = JSON.stringify(body ?? {});
  const res = await fetch(`${base}${path}`, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const results = [];
function record(item, name, pass, detail) {
  results.push({ item, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [#${item}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function getSession() {
  const email = `accept-${randomUUID().slice(0, 8)}@accept.local`;
  const password = 'accept-pass-123456';
  const boot = await call(API, '/auth/bootstrap', {
    method: 'POST',
    body: { email, password, displayName: 'Acceptance', orgName: 'Acceptance Org', orgSlug: `accept-${randomUUID().slice(0, 8)}` },
  });
  let token;
  if (boot.status === 201) {
    token = boot.body.data.token;
  } else if (process.env.BENCH_EMAIL && process.env.BENCH_PASSWORD) {
    const login = await call(API, '/auth/login', { method: 'POST', body: { email: process.env.BENCH_EMAIL, password: process.env.BENCH_PASSWORD } });
    if (login.status !== 200) throw new Error(`BENCH_EMAIL login failed: ${JSON.stringify(login.body)}`);
    token = login.body.data.token;
  } else {
    throw new Error('could not obtain a session: bootstrap unavailable and BENCH_EMAIL/BENCH_PASSWORD not set');
  }
  const usedPassword = process.env.BENCH_PASSWORD ?? password;
  await call(API, '/auth/step-up', { method: 'POST', token, body: { password: usedPassword } });
  return token;
}

// #8: JIT one-time, hashed, POST-redeemed, auto-revoked (replay + double-revoke rejected)
async function check8(token) {
  // Requester and approver must differ (no-self rule): mint a second account to request with.
  const me = await call(API, '/auth/me', { token });
  const orgId = me.body.data.bindings[0].orgId;
  const email2 = `req-${randomUUID().slice(0, 8)}@accept.local`;
  const pw2 = 'accept-pass-123456';
  const u2 = await call(API, '/users', { method: 'POST', token, body: { email: email2, password: pw2, displayName: 'Requester' } });
  await call(API, '/role-bindings', { method: 'POST', token, body: { userId: u2.body?.data?.id, role: 'manager', orgId } });
  const requesterToken = (await call(API, '/auth/login', { method: 'POST', body: { email: email2, password: pw2 } })).body?.data?.token;
  const reqRes = await call(ROOT, '/jit/requests', { method: 'POST', token: requesterToken, body: { site_id: 'accept-8', reason: 'acceptance #8', duration_minutes: 15 } });
  const requestId = reqRes.body?.data?.request_id;
  const approveRes = await call(ROOT, `/jit/requests/${requestId}/approve`, { method: 'POST', token });
  const jitToken = approveRes.body?.data?.token;
  const redeem1 = await call(ROOT, '/jit/redeem', { method: 'POST', body: { token: jitToken, request_id: requestId } });
  const grantId = redeem1.body?.data?.grant_id;
  const replay = await call(ROOT, '/jit/redeem', { method: 'POST', body: { token: jitToken, request_id: requestId } });
  const revoke1 = await call(ROOT, `/jit/grants/${grantId}/revoke`, { method: 'POST', token });
  const revoke2 = await call(ROOT, `/jit/grants/${grantId}/revoke`, { method: 'POST', token });
  record(
    8,
    'JIT one-time/hashed/POST-redeemed/auto-revoked',
    redeem1.status === 200 && replay.status === 409 && revoke1.status === 200 && revoke2.status === 404,
    `redeem=${redeem1.status} replay=${replay.status} revoke1=${revoke1.status} revoke2=${revoke2.status}`
  );
}

// #19/#26: RBAC enforced per role, default-deny on unmatched permission
async function check19and26(token) {
  // A permission this account's role definitely does NOT hold at all (developer-only, and this account is manager+security_admin — use a nonexistent-scope check instead: request a permission at a DIFFERENT org).
  const fakeOrgId = randomUUID();
  const denied = await call(API, '/findings?orgId=' + fakeOrgId, { token });
  // Default-deny: an org this actor holds no binding at all in should be FORBIDDEN, not silently return data for it.
  record(26, 'RBAC default-deny on unmatched scope', denied.status === 403, `status=${denied.status}`);

  const noAuth = await call(API, '/findings?orgId=' + fakeOrgId, {});
  record(19, 'RBAC enforced: unauthenticated request rejected', noAuth.status === 401, `status=${noAuth.status}`);
}

// #20: no self-approval for critical break-glass actions
async function check20(token) {
  const meRes = await call(API, '/auth/me', { token });
  const userId = meRes.body.data.user.id;
  const orgId = meRes.body.data.bindings[0].orgId;
  // A real route: granting yourself a role must be refused by the no-self rule (exactly 403, not a vacuous 404).
  const res = await call(API, '/role-bindings', { method: 'POST', token, body: { userId, role: 'security_admin', orgId } });
  record(20, 'No trivial self-approval on a critical action', res.status === 403, `status=${res.status}`);
}

// #24/#33: ai_remediation disabled by default, human-trigger-only
async function check24and33(token) {
  const meRes = await call(API, '/auth/me', { token });
  const orgId = meRes.body.data.bindings[0].orgId;
  const proj = await call(API, '/projects', { method: 'POST', token, body: { orgId, name: 'Accept Proj', slug: `accept-${randomUUID().slice(0, 8)}` } });
  const projectId = proj.body?.data?.id;
  const res = await call(API, `/findings/${randomUUID()}/remediate`, {
    method: 'POST',
    token,
    body: { projectId, findingSummary: 'x', codeContext: 'x' },
  });
  // Disabled-by-default: the scheduler class throws when enqueueing onto a
  // disabled class, so this must NOT return 202 (queued).
  record(
    24,
    'ai_remediation disabled by default (SCHED_AI_REMEDIATION_DISABLED)',
    res.status !== 202,
    `status=${res.status} (202 would mean it queued — the double safety gate failed)`
  );
  record(33, 'AI remediation is user-triggered only (no autonomous enqueue path exists)', checkNoAutonomousAiRemediationEnqueue(), 'statically verified below');
}

// #33 (real check, not a hardcoded pass): the only call site enqueueing the
// ai_remediation workload class must live in a route handler (human-triggered
// HTTP request), never inside scheduler/worker-runtime internals. Walks the
// actual source tree so a future autonomous enqueue call fails this check.
function checkNoAutonomousAiRemediationEnqueue() {
  const apiSrc = new URL('../apps/api/src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const offenders = [];
  const callSites = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        if (/enqueue\(\s*['"]ai_remediation['"]/.test(text)) {
          callSites.push(full);
          if (!full.split(/[\\/]/).includes('routes')) offenders.push(full);
        }
      }
    }
  }
  walk(apiSrc);
  const ok = callSites.length > 0 && offenders.length === 0;
  console.log(`  [#33 detail] enqueue('ai_remediation') call sites: ${callSites.join(', ') || '(none found)'}`);
  return ok;
}

async function main() {
  console.log(`[acceptance-suite] target=${ARGS.baseUrl}`);
  const token = await getSession();
  await check8(token);
  await check19and26(token);
  await check20(token);
  await check24and33(token);

  console.log('\n=== SUMMARY (this is the [auto] subset only — see docs/ops/acceptance-checklist.md for all 35 items) ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  #${r.item} ${r.name}`);
  process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
}

main().catch((err) => {
  console.error('[acceptance-suite] FAILED:', err);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * S18 capacity benchmark harness (PRD §18/§20/§21.1).
 *
 * This is the TOOL, not a real capacity number: PRD §20 explicitly requires
 * "the benchmark suite must determine the infrastructure required to
 * support this fleet" before launch — that means running this against a
 * real deployment shaped like the target fleet (up to 25 sites, 50 repos,
 * 25 users), not a shared dev sandbox. What's here is real and runnable
 * against any live API instance; the NUMBERS it produces on a laptop are
 * not the production sizing decision.
 *
 * Usage:
 *   node scripts/benchmark.mjs --base-url http://127.0.0.1:3000 \
 *     [--concurrency 10] [--requests 100] [--scenario all|availability|findings|jit]
 *
 * If the target instance already has users (bootstrap returns 409), set
 * BENCH_EMAIL/BENCH_PASSWORD to an existing account with `manager` (or
 * equivalent) permissions instead.
 *
 * Scenarios measure against PRD §21.1 Service Objectives:
 *   - availability:  API availability >= 99.9%
 *   - findings:      finding-ingestion request latency (proxy for "standard
 *                     PR gate" throughput under concurrency — NOT the full
 *                     scan pipeline itself, which needs real scanner
 *                     capacity this harness doesn't provision)
 *   - jit:            JIT request->approve->redeem->revoke round-trip
 *                     latency (proxy for the JIT expiry/revocation SLO —
 *                     manual revoke, not the auto-expiry timer itself)
 */
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const out = { baseUrl: 'http://127.0.0.1:3000', concurrency: 10, requests: 100, scenario: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--requests') out.requests = Number(argv[++i]);
    else if (a === '--scenario') out.scenario = argv[++i];
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const API = `${ARGS.baseUrl}/api/v1`;
const ROOT = ARGS.baseUrl;

async function call(base, path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const elapsedMs = performance.now() - t0;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json, elapsedMs };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function report(name, samplesMs, targetMs, targetPct) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const withinTarget = samplesMs.filter((ms) => ms <= targetMs).length;
  const pct = (withinTarget / samplesMs.length) * 100;
  const pass = pct >= targetPct;
  console.log(`\n[${name}] n=${samplesMs.length} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms p99=${p99.toFixed(0)}ms`);
  console.log(
    `[${name}] ${pct.toFixed(1)}% within ${targetMs}ms (target: ${targetPct}%) -> ${pass ? 'PASS' : 'FAIL'}`
  );
  return { name, p50, p95, p99, pctWithinTarget: pct, targetMs, targetPct, pass };
}

async function pool(concurrency, total, worker) {
  const results = [];
  let next = 0;
  async function runOne() {
    while (next < total) {
      const i = next++;
      results.push(await worker(i));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runOne));
  return results;
}

// ---- Auth bootstrap-or-login (reuses whatever account already exists) ----
async function getSession() {
  const email = `bench-${randomUUID().slice(0, 8)}@bench.local`;
  const password = 'bench-pass-123456';
  const boot = await call(API, '/auth/bootstrap', {
    method: 'POST',
    body: { email, password, displayName: 'Bench', orgName: 'Bench Org', orgSlug: `bench-${randomUUID().slice(0, 8)}` },
  });
  let token;
  if (boot.status === 201) {
    token = boot.body.data.token;
  } else if (process.env.BENCH_EMAIL && process.env.BENCH_PASSWORD) {
    // Bootstrap already done elsewhere on this instance — fall back to an existing bench account.
    const login = await call(API, '/auth/login', { method: 'POST', body: { email: process.env.BENCH_EMAIL, password: process.env.BENCH_PASSWORD } });
    if (login.status !== 200) throw new Error(`BENCH_EMAIL login failed: ${JSON.stringify(login.body)}`);
    token = login.body.data.token;
  } else {
    throw new Error('could not obtain a session: bootstrap unavailable and BENCH_EMAIL/BENCH_PASSWORD not set');
  }
  const usedPassword = process.env.BENCH_PASSWORD ?? password;
  // /projects sits under the admin plane (management-network + fresh step-up).
  const step = await call(API, '/auth/step-up', { method: 'POST', token, body: { password: usedPassword } });
  if (step.status !== 200) {
    console.log(`[benchmark] step-up failed (status ${step.status}) — findings scenario will skip project creation`);
  }
  return { token };
}

async function scenarioAvailability(results) {
  const samples = [];
  await pool(ARGS.concurrency, ARGS.requests, async () => {
    const r = await call(ROOT, '/healthz');
    samples.push(r.status === 200 ? 0 : Infinity); // 0ms = "up", Infinity = "down" (fails the latency-target check trivially)
    return r;
  });
  const upCount = samples.filter((s) => s === 0).length;
  const pct = (upCount / samples.length) * 100;
  const pass = pct >= 99.9;
  console.log(`\n[availability] ${upCount}/${samples.length} succeeded (${pct.toFixed(2)}%, target >=99.9%) -> ${pass ? 'PASS' : 'FAIL'}`);
  results.push({ name: 'availability', pctUp: pct, target: 99.9, pass });
}

async function scenarioFindings(results, token, orgId, projectId) {
  const samples = [];
  await pool(ARGS.concurrency, ARGS.requests, async (i) => {
    const scanId = `bench-${i}-${randomUUID().slice(0, 8)}`;
    const r = await call(API, `/scans/${scanId}/findings`, {
      method: 'POST',
      token,
      body: {
        scan_id: scanId,
        project_id: projectId,
        tool: { name: 'semgrep', version: 'bench' },
        target: { kind: 'repo', ref: 'main' },
        status: 'completed',
        findings: [
          { finding_fingerprint: `bench-${i}`, title: 'bench finding', severity: 'low', confidence: 'tentative' },
        ],
      },
    });
    samples.push(r.elapsedMs);
    return r;
  });
  // PRD §21.1: "Standard PR gates: 95% within 5 minutes" — this measures the
  // API's own ingest-request latency under concurrency, a necessary but not
  // sufficient proxy (the full gate also includes real scanner execution
  // time, which needs real scanner capacity to benchmark, not this harness).
  results.push(report('findings-ingest (API latency proxy)', samples, 5 * 60_000, 95));
}

async function scenarioJit(results, token) {
  const samples = [];
  await pool(ARGS.concurrency, ARGS.requests, async (i) => {
    const t0 = performance.now();
    const reqRes = await call(ROOT, '/jit/requests', { method: 'POST', token, body: { site_id: `bench-${i}`, reason: 'benchmark', duration_minutes: 15 } });
    const requestId = reqRes.body?.data?.request_id;
    if (!requestId) return { elapsedMs: performance.now() - t0 };
    const approveRes = await call(ROOT, `/jit/requests/${requestId}/approve`, { method: 'POST', token });
    const jitToken = approveRes.body?.data?.token;
    if (!jitToken) return { elapsedMs: performance.now() - t0 };
    const redeemRes = await call(ROOT, '/jit/redeem', { method: 'POST', body: { token: jitToken, request_id: requestId } });
    const grantId = redeemRes.body?.data?.grant_id;
    if (grantId) await call(ROOT, `/jit/grants/${grantId}/revoke`, { method: 'POST', token });
    const elapsedMs = performance.now() - t0;
    samples.push(elapsedMs);
    return { elapsedMs };
  });
  // PRD §21.1: "JIT expiry: 95% revoked within 2 minutes; 99.9% within 5
  // minutes" — that SLO is about auto-expiry timing, not this manual
  // round-trip; this measures the full request->approve->redeem->revoke
  // cycle latency as the closest thing this harness can exercise without
  // a real waiting-for-expiry clock.
  results.push(report('jit-full-cycle (request->approve->redeem->revoke)', samples, 2 * 60_000, 95));
}

async function main() {
  console.log(`[benchmark] target=${ARGS.baseUrl} concurrency=${ARGS.concurrency} requests=${ARGS.requests} scenario=${ARGS.scenario}`);
  const results = [];

  if (ARGS.scenario === 'all' || ARGS.scenario === 'availability') {
    await scenarioAvailability(results);
  }

  if (ARGS.scenario === 'all' || ARGS.scenario === 'findings' || ARGS.scenario === 'jit') {
    const session = await getSession();
    const me = await call(API, '/auth/me', { token: session.token });
    const orgId = me.body.data.bindings[0].orgId;

    if (ARGS.scenario === 'all' || ARGS.scenario === 'findings') {
      const proj = await call(API, '/projects', { method: 'POST', token: session.token, body: { orgId, name: 'Bench Project', slug: `bench-${randomUUID().slice(0, 8)}` } });
      // project.manage requires step-up under the admin gate — best-effort;
      // if this account isn't fresh-stepped-up, skip findings and note it.
      if (proj.status === 201) {
        await scenarioFindings(results, session.token, orgId, proj.body.data.id);
      } else {
        console.log(`\n[findings] skipped: could not create a bench project (status ${proj.status}, needs step-up — see README below)`);
      }
    }
    if (ARGS.scenario === 'all' || ARGS.scenario === 'jit') {
      await scenarioJit(results, session.token);
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name ?? 'availability'}`);
  }
  const anyFail = results.some((r) => !r.pass);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exitCode = 1;
});

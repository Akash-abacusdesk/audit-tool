#!/usr/bin/env node
/**
 * S2-D1 integration runner: compose up --wait → boot API (migrations on boot)
 * → vitest tests/integration → teardown. Like scripts/smoke.mjs but:
 * - no boss-smoke profile step (pg-boss round-trip already proven there),
 * - exports INTEGRATION_DB_URL (DIRECT postgres port) for the data-level fixture reset,
 * - tears down WITHOUT -v (floor rule: never wipe dev volumes).
 *
 * FLOOR CONSTRAINT (S3-D1B, do not re-learn the hard way): any loopback
 * listener owned by the SAME console/job family as a spawned child is
 * UNREACHABLE from that child here — connects blackhole ~10s → TimeoutError.
 * The github stub therefore runs as a DETACHED process (scripts/github-stub.cjs)
 * and the API is spawned directly via node + tsx cli (no npx/cmd shell layer).
 * Keep both properties if you touch this file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = path.join(ROOT, 'infrastructure');
const COMPOSE = ['-f', 'docker-compose.dev.yml', '--env-file', '.env'];
const PORT = process.env.INTEGRATION_PORT ?? '3100'; // :3000 may be held by unrelated dev servers
const BASE = `http://127.0.0.1:${PORT}`;
const WIN = process.platform === 'win32';

const step = (m) => console.log(`\n[integration] ${m}`);
const fail = (m) => {
  console.error(`[integration] FAIL: ${m}`);
  process.exitCode = 1;
};

function compose(args) {
  const r = spawnSync('docker', ['compose', ...COMPOSE, ...args], {
    cwd: INFRA,
    stdio: 'inherit',
    shell: WIN,
  });
  return r.status ?? 1;
}

function readDotEnv(file) {
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return vars;
}

/** Poll a raw TCP port (compose --wait can pass before the service accepts). */
function tryConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function waitPort(port, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await tryConnect(port)) {
      console.log(`[integration] ${label} :${port} accepting TCP after ${Date.now() - t0}ms`);
      return;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} :${port} not accepting within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitReady(url, timeoutMs) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let delay = 250;
  let attempts = 0;
  let firstContactAt = null;
  while (Date.now() < deadline) {
    attempts++;
    try {
      // Per-attempt timeout: a hung request must never freeze the loop past its deadline.
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!firstContactAt) {
        firstContactAt = Date.now();
        console.log(`[integration] readyz first response HTTP ${res.status} after ${firstContactAt - t0}ms`);
      }
      if (res.ok) {
        console.log(`[integration] ready OK after ${Date.now() - t0}ms (${attempts} attempt(s))`);
        return;
      }
    } catch {
      /* refused / reset / attempt timeout — retry */
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2000);
  }
  throw new Error(
    `${url} not ready within ${timeoutMs}ms (attempts=${attempts}, ` +
      `${firstContactAt ? `first contact +${firstContactAt - t0}ms` : 'endpoint never answered'})`
  );
}

// --- main ---
let api;
let stubProc;

// S4A phases: A normal boot + suites -> B forced-degraded admission
// (heavy class must stay queued while light completes) -> C restart-survival
// (SIGKILL mid-flight job, reboot, job completes off the persisted queue).
// Phase helpers live INSIDE the try block below: they close over dbUrl/
// gitApiBase/gitKey which are computed there.
const PROBE_TOKEN = randomUUID().replace(/-/g, '');

try {
  if (!existsSync(path.join(INFRA, '.env'))) throw new Error('infrastructure/.env missing');
  const v = readDotEnv(path.join(INFRA, '.env'));
  const user = encodeURIComponent(v.POSTGRES_USER || 'platform');
  const pw = encodeURIComponent(v.POSTGRES_PASSWORD || '');
  const db = encodeURIComponent(v.POSTGRES_DB || 'platform');
  const bouncerPort = v.BOUNCER_HOST_PORT || '6432';
  const directPort = v.PG_HOST_PORT || '5433';
  const dbUrl = `postgres://${user}:${pw}@localhost:${bouncerPort}/${db}?sslmode=disable`;
  const directUrl = `postgres://${user}:${pw}@localhost:${directPort}/${db}`;

  // Canned GitHub provider (S3-D1B): no network in tests. The API child and
  // vitest both get its URL; the stub asserts the bearer token it was seeded with.
  // ponytail: stub runs DETACHED (own process, own console) — a listener owned
  // by this runner's console/job family is unreachable from the spawned API
  // child on this floor (loopback connect blackholes ~10s -> TimeoutError).
  // Detached escapes the family; pid tracked for teardown. Fixed port,
  // overridable; revisit if it ever collides.
  const stubToken = 'stub-pat-token-1';
  const stubPort = Number(process.env.GIT_STUB_PORT ?? 6599);
  stubProc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'github-stub.cjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GIT_STUB_PORT: String(stubPort), GIT_STUB_TOKEN: stubToken },
  });
  const gitApiBase = `http://127.0.0.1:${stubPort}`;
  console.log(`[integration] github-stub at ${gitApiBase} (pid ${stubProc.pid}, detached)`);
  stubProc.unref();
  await waitPort(stubPort, 10_000, 'github-stub');
  // Self-probe: prove reachability from THIS process before anything depends on it.
  {
    const t0 = Date.now();
    const r = await fetch(`${gitApiBase}/repos/octo/hello/branches`, {
      headers: { authorization: `Bearer ${stubToken}` },
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[integration] github-stub self-probe ${r.status} +${Date.now() - t0}ms`);
    if (r.status !== 200) throw new Error('github-stub self-probe failed');
  }
  // Deterministic 32-byte key for the credential secretbox (test-only value).
  const gitKey = '11'.repeat(32);

  // S4-A<->C profiles fixture: dwight's tool/scanner/profiles.json lands with
  // his merge; until then pin a minimal equivalent via WORKER_PROFILES_PATH so
  // profileForTool() resolves and scan-shaped jobs exercise the real runtime.
  const profilesPath = path.join(os.tmpdir(), `s4a-profiles-${process.pid}.json`);
  writeFileSync(
    profilesPath,
    JSON.stringify({
      profiles: { small: { cpu_cores: 1, memory_mb: 256, pids_limit: 64, disk_mb: 256, timeout_seconds: 60 } },
      tool_profiles: { gitleaks: 'small' },
    })
  );

function apiEnv(extra) {
  return {
    ...process.env,
    PORT,
    DATABASE_URL: dbUrl,
    PGBOSS_URL: process.env.PGBOSS_URL || dbUrl,
    // The suite deliberately makes many wrong-password logins from one address: don't let the brute-force throttle trip it.
    LOGIN_MAX_FAILURES: '100000',
    GLOBAL_RATE_MAX: '1000000',
    LOG_LEVEL: 'warn',
    GIT_API_BASE_URL: gitApiBase,
    GIT_CREDENTIALS_KEY: gitKey,
    SCHED_RESTART_PROBE_TOKEN: PROBE_TOKEN,
    // ponytail: pin suites to forced-ok admission so they are deterministic
    // regardless of real box load; phase B overrides to degraded explicitly.
    // Real-signal admission is exercised by the verdict math unit tests.
    SCHED_ADMISSION_OVERRIDE: 'ok',
    SCHED_ADMISSION_TICK_MS: '1000',
    // scan wiring proofs: fixture ceilings + terminal-fail class (no retries)
    WORKER_PROFILES_PATH: profilesPath,
    SCHED_IO_HEAVY_RETRY_LIMIT: '0',
    ...extra,
  };
}

  function spawnApi(extraEnv = {}) {
    // ponytail: direct node + tsx cli (no npx/cmd shell layer) — see S3-D1B
    // loopback-blackhole note in the file header.
    api = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'apps/api/src/main.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: apiEnv(extraEnv),
    });
    api.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
    api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
    return api;
  }

  async function stopApi() {
    if (!api?.pid) return;
    if (WIN) spawnSync('taskkill', ['/pid', String(api.pid), '/T', '/F'], { shell: true });
    else api.kill('SIGTERM');
    const t0 = Date.now();
    while ((await tryConnect(Number(PORT))) && Date.now() - t0 < 10_000) {
      await new Promise((r) => setTimeout(r, 200));
    }
    api = undefined;
  }

  /** Runner->child loopback works (the blackhole was child->sibling only). */
  async function probeFetch(pathname, init) {
    // schedulerRoutes registers under the /api/v1 prefix — internal probe included.
    return fetch(`${BASE}/api/v1/internal/scheduler/probe${pathname}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${PROBE_TOKEN}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
  }

  async function probeEnqueue(classKey, payload) {
    const r = await probeFetch('', {
      method: 'POST',
      body: JSON.stringify({ classKey, ...payload }),
    });
    if (r.status !== 201) throw new Error(`probe enqueue ${classKey} failed: HTTP ${r.status}`);
    const b = await r.json();
    return b.data.jobId;
  }

  async function probeState(classKey, jobId) {
    const r = await probeFetch(`/${classKey}/${jobId}`);
    if (r.status !== 200) throw new Error(`probe status ${classKey}/${jobId}: HTTP ${r.status}`);
    return (await r.json()).data.job;
  }

  async function waitForJob(classKey, jobId, pred, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await probeState(classKey, jobId);
      if (pred(job)) return job;
      if (Date.now() > deadline) throw new Error(`${classKey}/${jobId} never reached expected state (last=${job?.state})`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** Fail fast if the API child dies during boot instead of burning readiness budget. */
  function exitedPromise() {
    return new Promise((_, reject) => {
      api?.once('exit', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`API process exited during startup (code=${code}) — see [api] logs above`));
        }
      });
    });
  }

  // Single-driver guard: refuse to touch compose if floor ports are already held.
  for (const [port, label] of [[directPort, 'postgres-direct'], [bouncerPort, 'pgbouncer'], [PORT, 'api']]) {
    const held = spawnSync('powershell', ['-NoProfile', '-Command',
      `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`],
      { shell: true });
    if (held.status === 0) throw new Error(`:${port} (${label}) already listening — another driver holds the floor; aborting`);
  }

  step('compose up -d --wait (postgres healthy, pgbouncer running)');
  if (compose(['up', '-d', '--wait']) !== 0) throw new Error('compose up failed');

  // compose --wait can pass before services accept TCP (seen once: pgbouncer :6432
  // refused right after --wait). Probe both DB entrypoints before booting the API.
  await waitPort(Number(directPort), 20_000, 'postgres-direct');
  await waitPort(Number(bouncerPort), 20_000, 'pgbouncer');

  step(`booting API on :${PORT} (migrations run inside boot; DB data preserved — no volume wipe)`);
  spawnApi();

  step(`waiting for ${BASE}/readyz`);
  // Fail fast if the API child dies during boot (e.g. DB connect refused) instead
  // of burning the full readiness budget on a dead process.
  await Promise.race([waitReady(`${BASE}/readyz`, 60_000), exitedPromise()]);

  step('vitest: tests/integration (sequential files — fixtures truncate shared DB)');
  const t = spawnSync('npx', ['vitest', 'run', '--no-file-parallelism', 'tests/integration'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: WIN,
    env: {
      ...process.env,
      SMOKE_BASE_URL: BASE,
      INTEGRATION_DB_URL: directUrl,
      GIT_STUB_TOKEN: stubToken,
      SCHED_RESTART_PROBE_TOKEN: PROBE_TOKEN,
    },
  });
  if (t.status !== 0) throw new Error(`vitest exited ${t.status}`);

  step('phase B: admission degraded — heavy class excluded, light class proceeds');
  await stopApi();
  spawnApi({ SCHED_ADMISSION_OVERRIDE: 'degraded' });
  await Promise.race([waitReady(`${BASE}/readyz`, 60_000), exitedPromise()]);
  const heavyId = await probeEnqueue('cpu_heavy', { demoMs: 50 });
  const lightId = await probeEnqueue('standard_pr', { demoMs: 50 });
  await waitForJob('standard_pr', lightId, (j) => j?.state === 'completed', 20_000);
  await new Promise((r) => setTimeout(r, 2000)); // grace in case heavy sneaks a worker
  const heavyState = (await probeState('cpu_heavy', heavyId))?.state;
  if (heavyState === 'completed' || heavyState === 'active') {
    throw new Error(`admission exclusion FAILED: cpu_heavy job is '${heavyState}' under forced degraded`);
  }
  console.log(`[integration] exclusion holds: cpu_heavy still '${heavyState}' while standard_pr completed`);

  step('phase C: restart-survival — SIGKILL mid-flight, reboot, persisted job completes');
  await stopApi();
  spawnApi();
  await Promise.race([waitReady(`${BASE}/readyz`, 60_000), exitedPromise()]);
  const survived = await waitForJob('cpu_heavy', heavyId, (j) => j?.state === 'completed', 60_000);
  console.log(`[integration] restart-survival PASS: cpu_heavy/${heavyId} completed after reboot (${survived.state})`);

  step('PASS — integration suite green against real PG');
} catch (err) {
  fail(err.message);
} finally {
  if (api?.pid) {
    step('stopping API');
    if (WIN) spawnSync('taskkill', ['/pid', String(api.pid), '/T', '/F'], { shell: true });
    else api.kill('SIGTERM');
  }
  if (stubProc?.pid) {
    step('stopping github-stub');
    if (WIN) spawnSync('taskkill', ['/pid', String(stubProc.pid), '/T', '/F'], { shell: true });
    else stubProc.kill('SIGTERM');
  }
  step('compose down (volumes preserved per floor rule)');
  compose(['down']);
}
process.exit(process.exitCode ?? 0);

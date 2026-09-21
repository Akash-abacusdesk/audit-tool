#!/usr/bin/env node
/**
 * One command, clean state → proof: S1-D6 smoke (build plan lines 163–169).
 * compose up --wait → API boot (migrates empty DB, starts pg-boss + reference worker)
 * → boss round-trip profile → vitest tests/smoke → teardown. Non-zero exit on any failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = path.join(ROOT, 'infrastructure');
const COMPOSE = ['-f', 'docker-compose.dev.yml', '--env-file', '.env'];
const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const WIN = process.platform === 'win32';

const step = (m) => console.log(`\n[smoke] ${m}`);
const fail = (m) => {
  console.error(`[smoke] FAIL: ${m}`);
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

async function waitReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} not ready within ${timeoutMs}ms`);
}

// --- main ---
let api;
try {
  const envFile = path.join(INFRA, '.env');
  if (!existsSync(envFile)) {
    step('.env missing — seeding from .env.example');
    copyFileSync(path.join(INFRA, '.env.example'), envFile);
  }
  const v = readDotEnv(envFile);
  const user = encodeURIComponent(v.POSTGRES_USER || 'platform');
  const pw = encodeURIComponent(v.POSTGRES_PASSWORD || '');
  const db = encodeURIComponent(v.POSTGRES_DB || 'platform');
  const bouncerPort = v.BOUNCER_HOST_PORT || '6432';
  // Apps connect through PgBouncer (docs/ops/docker-dev-env.md); pg-boss shares the URL.
  const dbUrl = `postgres://${user}:${pw}@localhost:${bouncerPort}/${db}?sslmode=disable`;

  step('compose up -d --wait (postgres healthy, pgbouncer running)');
  if (compose(['up', '-d', '--wait']) !== 0) throw new Error('compose up failed');

  step('building @platform/shared (dist is gitignored — virgin checkouts have none)');
  if (spawnSync('npm', ['run', 'build', '--workspace', '@platform/shared'], { cwd: ROOT, stdio: 'inherit', shell: WIN }).status !== 0)
    throw new Error('@platform/shared build failed');

  step(`booting API on :${new URL(BASE).port} — migrations run on the empty DB inside boot`);
  api = spawn('npx', ['tsx', 'apps/api/src/main.ts'], {
    cwd: ROOT,
    shell: WIN,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: new URL(BASE).port || '3000',
      DATABASE_URL: dbUrl,
      PGBOSS_URL: process.env.PGBOSS_URL || dbUrl,
      LOG_LEVEL: 'warn',
    },
  });
  api.stdout.on('data', (d) => process.stdout.write(`[api] ${d}`));
  api.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));

  step(`waiting for ${BASE}/readyz (PG via PgBouncer + pg-boss started)`);
  await waitReady(`${BASE}/readyz`, 60_000);

  step('pg-boss round-trip proof (boss-smoke one-shot through pgbouncer)');
  if (compose(['--profile', 'smoke', 'up', '--build', '--exit-code-from', 'boss-smoke', 'boss-smoke']) !== 0)
    throw new Error('boss-smoke profile failed');

  step('vitest: tests/smoke');
  const t = spawnSync('npx', ['vitest', 'run', 'tests/smoke'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: WIN,
    env: { ...process.env, SMOKE_BASE_URL: BASE },
  });
  if (t.status !== 0) throw new Error(`vitest exited ${t.status}`);

  step('PASS — stack verified from clean state');
} catch (err) {
  fail(err.message);
} finally {
  if (api?.pid) {
    step('stopping API');
    if (WIN) spawnSync('taskkill', ['/pid', String(api.pid), '/T', '/F'], { shell: true });
    else api.kill('SIGTERM');
  }
  step('compose down -v (wipe for next clean run)');
  compose(['down', '-v']);
}
process.exit(process.exitCode ?? 0);

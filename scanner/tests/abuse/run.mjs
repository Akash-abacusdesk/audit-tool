import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve @platform/worker-runtime: package resolution first (monorepo checkout),
// then direct dist path relative to this file (tool/scanner/tests/abuse/run.mjs).
let wr;
try {
  const require = createRequire(import.meta.url);
  wr = require('@platform/worker-runtime');
} catch {
  wr = await import(fileURLToPath(new URL('../../../packages/worker-runtime/dist/index.js', import.meta.url)));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, 'cases');

// Fast watchdog/poll knobs for battery pacing (contract defaults are production-tuned).
process.env.WORKER_TERM_GRACE_MS ||= '3000';
process.env.WORKER_OUT_DU_POLL_MS ||= '1000';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
}
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const engineUp = await wr.dockerAvailable();
check('T0 engine available', engineUp);
if (!engineUp) { console.log(`RESULT ${pass}/${pass + fail}`); process.exit(1); }

const caseFiles = (await fs.readdir(CASES_DIR)).filter(f => f.endsWith('.json')).sort();

for (const file of caseFiles) {
  const testCase = JSON.parse(await fs.readFile(path.join(CASES_DIR, file), 'utf8'));
  const id = testCase.id;
  try {
    await runCase(testCase);
  } catch (e) {
    check(`${id}: no harness crash`, false, String(e && e.stack || e));
  }
}

// Whole-battery teardown honesty: floor must be clean when we leave.
const leftoverCtr = await wr.listWorkerContainers('com.platform.worker=true');
const leftoverNet = await wr.listWorkerNetworks('com.platform.worker.net=true');
check('battery end: zero leftover containers', leftoverCtr.length === 0, JSON.stringify(leftoverCtr.map(c => c.name)));
check('battery end: zero leftover networks', leftoverNet.length === 0, JSON.stringify(leftoverNet.map(n => n.name)));

console.log(`RESULT ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);

// ---------- case runner ----------

async function runCase(testCase) {
  const id = testCase.id;
  const spec = testCase.spec || {};
  const expect = testCase.expect || {};

  // Sweep-tick is a pure runtime call, no run needed.
  if (expect.kind === 'sweepTick') {
    const r = await wr.sweepOnce(0);
    check(`${id}: sweep tick executed`,
      typeof r.sweptContainers === 'number' && typeof r.sweptNetworks === 'number',
      JSON.stringify(r));
    return;
  }

  // Preflight-deny: the throw IS the pass condition.
  if (expect.kind === 'preflightDeny') {
    const out = await tmpDir('s4c-out-');
    try {
      await wr.runWorkerJob({ runId: `s4c-${id}`, outDir: out, limits: baseLimits(), ...spec });
      check(`${id}: preflight denied`, false, 'no throw');
    } catch (e) {
      const re = new RegExp(expect.errorPattern, 'i');
      check(`${id}: preflight denied`, re.test(String(e.message)), String(e.message));
    }
    return;
  }

  // Record-only row (documented bridge allowlist gap).
  if (expect.kind === 'recordOnly') {
    const out = await tmpDir('s4c-out-');
    const t0 = Date.now();
    const res = await wr.runWorkerJob({ runId: `s4c-${id}`, outDir: out, limits: limitsFor(spec), ...stripLimits(spec) });
    console.log(`INFO ${id}: status=${res.status} exit=${res.exitCode} tail=${JSON.stringify(res.logsTail.slice(-120))} (${Date.now() - t0}ms)`);
    check(`${id}: recorded (record-only row)`, true);
    return;
  }

  // Concurrency row.
  if (expect.kind === 'concurrentIsolation') {
    const n = spec.concurrency || 2;
    const outs = [];
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const out = await tmpDir(`s4c-out-${id}-`);
      outs.push(out);
      jobs.push(wr.runWorkerJob({
        runId: `s4c-${id}-${i}`,
        image: spec.image,
        cmd: spec.cmd,
        outDir: out,
        limits: limitsFor(spec),
        egress: spec.egress,
      }));
    }
    // Mid-flight: distinct labeled containers/networks must coexist.
    await new Promise(r => setTimeout(r, 1500));
    const ctr = await wr.listWorkerContainers('com.platform.worker=true');
    const net = await wr.listWorkerNetworks('com.platform.worker.net=true');
    check(`${id}: >= ${spec.midFlightAsserts?.containersLabeledAtLeast ?? n} labeled containers mid-flight`, ctr.length >= n, JSON.stringify(ctr.map(c => c.name)));
    check(`${id}: >= ${spec.midFlightAsserts?.networksLabeledAtLeast ?? n} labeled networks mid-flight`, net.length >= n, JSON.stringify(net.map(x => x.name)));
    check(`${id}: container names distinct`, new Set(ctr.map(c => c.name)).size === ctr.length);

    const results = await Promise.all(jobs);
    results.forEach((res, i) => check(`${id}[${i}]: ${expect.statuses[i] ?? 'completed'}`, res.status === (expect.statuses[i] ?? 'completed'), res.status));
    return; // leftover check happens battery-wide at the end
  }

  // Cancel row.
  if (expect.kind === 'cancelled') {
    const out = await tmpDir(`s4c-out-${id}-`);
    const t0 = Date.now();
    const job = wr.runWorkerJob({ runId: `s4c-${id}`, image: spec.image, cmd: spec.cmd, outDir: out, limits: limitsFor(spec), egress: spec.egress });
    setTimeout(() => { wr.cancel(`s4c-${id}`).catch(() => {}); }, spec.cancelAfterMs ?? 4000);
    const res = await job;
    if (spec.alsoCancelUnknownId) await wr.cancel(`s4c-${id}-never-existed`);
    check(`${id}: cancelled flagged`, res.cancelled === true && res.status === 'cancelled', `${res.status} cancelled=${res.cancelled}`);
    check(`${id}: within time bound`, Date.now() - t0 < (expect.maxElapsedMs ?? 30000), `${Date.now() - t0}ms`);
    return;
  }

  // Standard single-run rows.
  const out = await tmpDir(`s4c-out-${id}-`);
  let workspaceDir;
  if (spec.workspaceFixture) {
    // Real RO-mounted /workspace so the tamper row exercises read-only denial,
    // not missing-directory failure.
    workspaceDir = await tmpDir(`s4c-ws-${id}-`);
    await fs.writeFile(path.join(workspaceDir, 'target.txt'), 'battery-fixture');
  }
  const t0 = Date.now();
  let res;
  try {
    res = await wr.runWorkerJob({
      runId: `s4c-${id}`,
      jobId: spec.jobId,
      image: spec.image,
      cmd: spec.cmd,
      workspaceDir,
      outDir: out,
      limits: limitsFor(spec),
      env: spec.env,
      egress: spec.egress,
    });
  } catch (e) {
    check(`${id}: run completed without unexpected throw`, false, String(e.message));
    return;
  }

  switch (expect.kind) {
    case 'logsContain': {
      if (expect.status) check(`${id}: status=${expect.status}`, res.status === expect.status, res.status);
      if (expect.exitCode != null) check(`${id}: exitCode=${expect.exitCode}`, res.exitCode === expect.exitCode, String(res.exitCode));
      for (const v of expect.values ?? []) check(`${id}: logs contain "${v}"`, res.logsTail.includes(v), JSON.stringify(res.logsTail.slice(-200)));
      for (const v of expect.logsForbid ?? []) check(`${id}: logs forbid "${v}"`, !res.logsTail.includes(v));
      break;
    }
    case 'containedRunaway': {
      check(`${id}: contained (${expect.statuses.join('|')})`, expect.statuses.includes(res.status), res.status);
      check(`${id}: terminated inside bound`, Date.now() - t0 < (expect.maxElapsedMs ?? 60000), `${Date.now() - t0}ms`);
      break;
    }
    case 'watchdogDiskKill': {
      // du-watchdog kill rides the SIGTERM->grace->SIGKILL path => status 'timedOut' + timedOut:true (pam, schema note @8f9487b).
      check(`${id}: killed on breach (${expect.statuses.join('|')})`, expect.statuses.includes(res.status), `${res.status} exit=${res.exitCode}`);
      if (expect.timedOutTrue) check(`${id}: timedOut flag set`, res.timedOut === true, `timedOut=${res.timedOut}`);
      check(`${id}: killed inside budget`, Date.now() - t0 < (expect.maxElapsedMs ?? 45000), `${Date.now() - t0}ms`);
      if (expect.artifactDirIntact) {
        const entries = await fs.readdir(out);
        check(`${id}: /out artifact dir intact post-kill`, Array.isArray(entries), JSON.stringify(entries));
      }
      break;
    }
    case 'timedOut': {
      check(`${id}: timedOut flagged`, res.timedOut === true && res.status === 'timedOut', `${res.status} timedOut=${res.timedOut}`);
      check(`${id}: inside budget+grace`, Date.now() - t0 < (expect.maxElapsedMs ?? 30000), `${Date.now() - t0}ms`);
      break;
    }
    case 'envAllowlist': {
      let keys = [];
      try { keys = (await fs.readFile(path.join(out, 'keys.txt'), 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
      catch { /* treated below */ }
      const unexpected = keys.filter(k => !(expect.allowedKeys ?? []).includes(k));
      const missing = (expect.mustIncludeKeys ?? []).filter(k => !keys.includes(k));
      check(`${id}: PLATFORM_JOB_ID injected`, missing.length === 0, `missing=${missing.join(',')}`);
      check(`${id}: no unexpected env keys`, unexpected.length === 0, `unexpected=${unexpected.join(',')}`);
      for (const v of expect.logsForbid ?? []) check(`${id}: not echoed in logs "${v}"`, !res.logsTail.includes(v));
      break;
    }
    default:
      check(`${id}: unknown expect.kind`, false, expect.kind);
  }
}

function baseLimits() {
  return { cpuCores: 1, memoryMb: 512, pidsLimit: 128, diskMb: 1024, timeoutSeconds: 60 };
}

function limitsFor(spec) {
  let lim = baseLimits();
  if (spec.limitsProfile && typeof wr.loadProfile === 'function') {
    lim = wr.loadProfile(spec.limitsProfile);
  }
  if (spec.timeoutSeconds) lim = { ...lim, timeoutSeconds: spec.timeoutSeconds };
  if (spec.limitsOverride) lim = { ...lim, ...spec.limitsOverride };
  return lim;
}

function stripLimits(spec) {
  const { limitsProfile, timeoutSeconds, limitsOverride, concurrency, midFlightAsserts, cancelAfterMs, alsoCancelUnknownId, jobId, env, ...rest } = spec;
  return rest;
}

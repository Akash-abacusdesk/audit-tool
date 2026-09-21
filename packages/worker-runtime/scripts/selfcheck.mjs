// Self-check for @platform/worker-runtime — pure logic only (no docker daemon).
// Run after `npm run build`: node scripts/selfcheck.mjs
import assert from 'node:assert/strict';
import { buildRunArgs } from '../dist/engine.js';
import { runIdFromWorkerName } from '../dist/registry.js';

const limits = {
  cpuCores: 1,
  memoryMb: 512,
  pidsLimit: 128,
  diskMb: 1024,
  timeoutSeconds: 900,
};

const args = buildRunArgs({
  name: 'platform-wkr-run1',
  image: 'example/scanner@sha256:abc',
  cmd: ['--json'],
  network: 'platform-wnet-run1',
  env: { B_KEY: 'b', A_KEY: 'a' },
  labels: { 'com.example.extra': '1' },
  roBinds: [{ host: 'C:/stage/run1', container: '/workspace' }],
  rwBinds: [{ host: 'C:/out/run1', container: '/out' }],
  tmpfs: [
    { path: '/tmp', sizeMb: 512 },
    { path: '/zap', sizeMb: 256 },
  ],
  limits,
});

const expect = [
  'create',
  '--name', 'platform-wkr-run1',
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--init',
  '--network', 'platform-wnet-run1',
  '--cpus', '1',
  '--memory', '512m',
  '--pids-limit', '128',
  '--env', 'A_KEY=a',
  '--env', 'B_KEY=b',
  '--label', 'com.platform.worker=true',
  '--label', 'com.example.extra=1',
  '--mount', 'type=bind,src=C:/stage/run1,dst=/workspace,readonly',
  '--mount', 'type=bind,src=C:/out/run1,dst=/out',
  '--mount', 'type=tmpfs,dst=/tmp,tmpfs-size=536870912',
  '--mount', 'type=tmpfs,dst=/zap,tmpfs-size=268435456',
  'example/scanner@sha256:abc',
  '--json',
];
assert.deepEqual(args, expect, `buildRunArgs mismatch:\n got: ${JSON.stringify(args)}\n exp: ${JSON.stringify(expect)}`);
assert.ok(!args.includes('--user'), 'must not pin --user (image user wins)');

assert.equal(runIdFromWorkerName('platform-wkr-run1'), 'run1');
assert.equal(runIdFromWorkerName('/platform-wkr-run1'), 'run1');
assert.equal(runIdFromWorkerName('unrelated'), null);

console.log('selfcheck: ALL PASS');

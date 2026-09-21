import { execFile } from 'node:child_process';
import type { ResourceLimits } from './types.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const WORKER_LABEL = 'com.platform.worker=true';
const NETWORK_LABEL = 'com.platform.worker.net=true';
const MAX_BUFFER = 16 * 1024 * 1024;

export function execDocker(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { windowsHide: true, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (err && typeof code !== 'number') {
          reject(err);
          return;
        }
        resolve({
          code: typeof code === 'number' ? code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await execDocker(['version', '--format', '{{json .}}'])).code === 0;
  } catch {
    return false;
  }
}

export async function imageUser(image: string): Promise<string | null> {
  let r: ExecResult;
  try {
    r = await execDocker(['image', 'inspect', '--format', '{{json .Config.User}}', image]);
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout.trim()) as string;
  } catch {
    return null;
  }
}

export interface WorkerContainerOpts {
  name: string;
  image: string;
  /** pierce the image ENTRYPOINT (e.g. ['/bin/sh']) so cmd runs as shell */
  entrypoint?: string[];
  cmd?: string[];
  network: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  roBinds: Array<{ host: string; container: string }>;
  rwBinds: Array<{ host: string; container: string }>;
  tmpfs: Array<{ path: string; sizeMb: number }>;
  limits: ResourceLimits;
}

export function buildRunArgs(o: WorkerContainerOpts): string[] {
  const args: string[] = [
    'create',
    '--name', o.name,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--init',
    '--network', o.network,
    '--cpus', String(o.limits.cpuCores),
    '--memory', `${o.limits.memoryMb}m`,
    '--pids-limit', String(o.limits.pidsLimit),
  ];
  for (const part of o.entrypoint ?? []) {
    args.push('--entrypoint', part);
  }
  for (const [k, v] of [...Object.entries(o.env)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    args.push('--env', `${k}=${v}`);
  }
  args.push('--label', WORKER_LABEL);
  for (const [k, v] of Object.entries(o.labels)) {
    args.push('--label', `${k}=${v}`);
  }
  for (const b of o.roBinds) {
    args.push('--mount', `type=bind,src=${b.host},dst=${b.container},readonly`);
  }
  for (const b of o.rwBinds) {
    args.push('--mount', `type=bind,src=${b.host},dst=${b.container}`);
  }
  for (const t of o.tmpfs) {
    args.push('--mount', `type=tmpfs,dst=${t.path},tmpfs-size=${t.sizeMb * 1024 * 1024}`);
  }
  args.push(o.image);
  if (o.cmd) args.push(...o.cmd);
  return args;
}

export async function createWorkerContainer(o: WorkerContainerOpts): Promise<string> {
  const r = await execDocker(buildRunArgs(o));
  if (r.code !== 0) {
    throw new Error(`docker create failed (${r.code}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export async function startContainer(id: string): Promise<void> {
  const r = await execDocker(['start', id]);
  if (r.code !== 0) {
    throw new Error(`docker start ${id} failed (${r.code}): ${r.stderr.trim()}`);
  }
}

export async function stopContainer(id: string, graceSeconds: number): Promise<void> {
  const r = await execDocker(['stop', '-t', String(graceSeconds), id]);
  if (r.code !== 0) {
    throw new Error(`docker stop ${id} failed (${r.code}): ${r.stderr.trim()}`);
  }
}

export async function waitContainer(id: string): Promise<number> {
  let r: ExecResult;
  try {
    r = await execDocker(['wait', id]);
  } catch {
    return -1;
  }
  if (/No such object|is not running/i.test(r.stderr + r.stdout)) return -1;
  if (r.code !== 0 && r.stdout.trim() === '') return -1;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : -1;
}

export async function containerLogs(id: string, tailLines: number): Promise<string> {
  try {
    const r = await execDocker(['logs', '--tail', String(tailLines), id]);
    return (r.stdout + r.stderr).trim();
  } catch {
    return '';
  }
}

export async function removeContainer(id: string, force: boolean): Promise<void> {
  const r = await execDocker(['rm', ...(force ? ['-f'] : []), id]);
  if (r.code !== 0 && !/no such/i.test(r.stderr)) {
    throw new Error(`docker rm ${id} failed (${r.code}): ${r.stderr.trim()}`);
  }
}

export interface ContainerRow {
  id: string;
  name: string;
  state: string;
  createdAtMs: number;
  labels: Record<string, string>;
}

function parseJsonLines(out: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj !== null && typeof obj === 'object') {
      rows.push(obj as Record<string, unknown>);
    }
  }
  return rows;
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function firstName(row: Record<string, unknown>): string {
  const v = row['Names'];
  if (Array.isArray(v)) {
    const f = v[0];
    return typeof f === 'string' ? f.replace(/^\//, '') : '';
  }
  return typeof v === 'string' ? v.replace(/^\//, '') : '';
}

function labelsOf(row: Record<string, unknown>): Record<string, string> {
  // `docker ps --format {{json .}}` emits Labels as a comma-joined
  // "k=v,k2=v2" STRING, not an object.
  const v = row['Labels'];
  if (typeof v === 'string' && v) {
    const out: Record<string, string> = {};
    for (const pair of v.split(',')) {
      const i = pair.indexOf('=');
      if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return out;
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, string>)
    : {};
}

function createdAtMs(row: Record<string, unknown>): number {
  const s = str(row, 'CreatedAt');
  // docker ps layout: "2026-08-26 13:37:00 +0000 UTC" — not Date.parse-able.
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})/.exec(s);
  if (!m) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? 0 : ms;
  }
  const offsetMin = (Number(m[4]) * 60 + Number(m[5])) * (m[3] === '-' ? -1 : 1);
  return Date.parse(`${m[1]}T${m[2]}Z`) - offsetMin * 60_000;
}

export async function listWorkerContainers(labelFilter: string): Promise<ContainerRow[]> {
  // ponytail: non-zero ps exit parses as empty list; daemon-down surfaces via dockerAvailable()
  const r = await execDocker(['ps', '-a', '--filter', `label=${labelFilter}`, '--format', '{{json .}}']);
  return parseJsonLines(r.stdout).map((row) => ({
    id: str(row, 'ID'),
    name: firstName(row),
    state: str(row, 'State'),
    createdAtMs: createdAtMs(row),
    labels: labelsOf(row),
  }));
}

export interface NetworkRow {
  name: string;
  createdAtMs: number;
}

export async function createNetwork(name: string, opts: { internal: boolean }): Promise<void> {
  const r = await execDocker([
    'network',
    'create',
    ...(opts.internal ? ['--internal'] : []),
    '--label',
    NETWORK_LABEL,
    name,
  ]);
  if (r.code !== 0) {
    throw new Error(`docker network create ${name} failed (${r.code}): ${r.stderr.trim()}`);
  }
}

export async function listWorkerNetworks(labelFilter: string): Promise<NetworkRow[]> {
  // ponytail: non-zero ps exit parses as empty list; daemon-down surfaces via dockerAvailable()
  const r = await execDocker([
    'network',
    'ls',
    '--filter',
    `label=${labelFilter}`,
    '--format',
    '{{json .}}',
  ]);
  return parseJsonLines(r.stdout).map((row) => ({
    name: str(row, 'Name'),
    createdAtMs: createdAtMs(row),
  }));
}

export async function removeNetwork(name: string): Promise<void> {
  const r = await execDocker(['network', 'rm', name]);
  if (r.code !== 0 && !/not found|no such/i.test(r.stderr)) {
    throw new Error(`docker network rm ${name} failed (${r.code}): ${r.stderr.trim()}`);
  }
}

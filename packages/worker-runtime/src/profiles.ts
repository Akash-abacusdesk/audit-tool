import { readFileSync } from 'node:fs';
import type { ResourceLimits } from './types.js';

/**
 * Loader for tool/scanner/profiles.json (S4-C, dwight owns the file):
 * ceilings are the one source of truth; scheduler admission may pick a
 * smaller profile within them. Path override via WORKER_PROFILES_PATH env
 * or explicit argument (repo layout changes should not break callers).
 *
 * SYNC contract: limits are composed into run specs at admission/spec-build
 * time (sync contexts — scheduler composer, test harnesses). Callers that
 * `await` these functions keep working unchanged.
 */

interface RawProfiles {
  profiles: Record<string, {
    cpu_cores?: number;
    memory_mb?: number;
    pids_limit?: number;
    disk_mb?: number;
    timeout_seconds?: number;
  }>;
  tool_profiles?: Record<string, string>;
}

function num(v: unknown, field: string, source: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`profiles: ${source}: ${field} missing/not positive`);
  }
  return v;
}

function normalize(p: NonNullable<RawProfiles['profiles'][string]>, key: string): ResourceLimits {
  return {
    cpuCores: num(p.cpu_cores, 'cpu_cores', key),
    memoryMb: num(p.memory_mb, 'memory_mb', key),
    pidsLimit: num(p.pids_limit, 'pids_limit', key),
    diskMb: num(p.disk_mb, 'disk_mb', key),
    timeoutSeconds: num(p.timeout_seconds, 'timeout_seconds', key),
  };
}

function resolvePath(path?: string): string {
  return path ??
    process.env.WORKER_PROFILES_PATH ??
    new URL('../../../scanner/profiles.json', import.meta.url).pathname
      .replace(/^\/([A-Za-z]:)/, '$1');
}

function readProfilesFile(path: string): RawProfiles {
  return JSON.parse(readFileSync(path, 'utf8')) as RawProfiles;
}

export function loadProfiles(path?: string): Record<string, ResourceLimits> {
  const raw = readProfilesFile(resolvePath(path));
  const out: Record<string, ResourceLimits> = {};
  for (const [key, p] of Object.entries(raw.profiles ?? {})) {
    if (!p) continue;
    out[key] = normalize(p, key);
  }
  if (Object.keys(out).length === 0) throw new Error('profiles: no profiles defined');
  return out;
}

export function loadProfile(name: string, path?: string): ResourceLimits {
  const all = loadProfiles(path);
  const hit = all[name];
  if (!hit) {
    throw new Error(`profiles: unknown profile '${name}' (have: ${Object.keys(all).join(', ')})`);
  }
  return hit;
}

export function profileForTool(tool: string, path?: string): ResourceLimits {
  const raw = readProfilesFile(resolvePath(path));
  const profileName = raw.tool_profiles?.[tool];
  if (!profileName) throw new Error(`profiles: no profile mapped for tool '${tool}'`);
  return loadProfile(profileName, path);
}

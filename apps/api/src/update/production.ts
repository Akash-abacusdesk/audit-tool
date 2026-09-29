/**
 * S13 production stand-in — D2. There is no real production WordPress host
 * wired into this checkout (Phase 3, see docs/ops/phase3-readiness.md), so
 * snapshot/promote have nothing real to act on. This gives them one: a
 * long-lived WordPress+MySQL pair per environment — same images as S11
 * staging, but persistent (not torn down after each run) and with wp-content
 * in a named docker volume so it survives across calls. Real mysqldump
 * restore points and real wp-cli promotions run against it. Swap for an SSH/
 * API-driven adapter once a real host exists; the call sites (update/worker.ts)
 * don't change.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execDocker, createNetwork } from '@platform/worker-runtime';
import { DB_PASSWORD, freePort, waitForMysql, waitForHttp } from '../staging/provisioner.js';

const WP_IMAGE = process.env.STAGING_WP_IMAGE ?? 'wordpress:6.6-apache@sha256:c30c1376b4d2c9d1e2328c2ee6149d133104d65873a98cbc6adc743a2964c4ba';
const DB_IMAGE = process.env.STAGING_DB_IMAGE ?? 'mysql:8@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d';
const CLI_IMAGE = process.env.UPDATE_WPCLI_IMAGE ?? 'wordpress:cli@sha256:0f7f0f895c379bb7b60b8f09562811084ac0424d544747f76d95cc785feccac0';
// The wordpress:apache image's wp-content is owned by uid 33 (www-data on its
// debian base); wordpress:cli's own www-data is a different uid (alpine base),
// so wp-cli must run as 33 explicitly or it can't write to a --volumes-from mount.
const WP_CONTENT_UID = '33:33';
const TAR_IMAGE = process.env.UPDATE_TAR_IMAGE ?? 'alpine:latest@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6';
const SNAPSHOT_DIR = process.env.UPDATE_SNAPSHOT_DIR ?? path.join(process.cwd(), 'data', 'update-snapshots');

export interface ProductionRuntime {
  networkName: string;
  dbContainer: string;
  wpContainer: string;
  contentVolume: string;
  hostPort: number;
}

function names(environmentId: string): Omit<ProductionRuntime, 'hostPort'> {
  return {
    networkName: `platform-prod-net-${environmentId}`,
    dbContainer: `platform-prod-db-${environmentId}`,
    wpContainer: `platform-prod-wp-${environmentId}`,
    contentVolume: `platform-prod-content-${environmentId}`,
  };
}

async function containerRunning(name: string): Promise<boolean> {
  const r = await execDocker(['inspect', '-f', '{{.State.Running}}', name]);
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function publishedPort(container: string): Promise<number | null> {
  const r = await execDocker(['port', container, '80/tcp']);
  if (r.code !== 0) return null;
  const m = r.stdout.trim().match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Idempotent: returns the existing containers if already running (the whole
 * point of "persistent"), otherwise stands them up. Content volume is
 * created once and never recreated, so wp-content survives restarts.
 */
export async function ensureProductionContainers(environmentId: string): Promise<ProductionRuntime> {
  const n = names(environmentId);

  if (await containerRunning(n.wpContainer)) {
    const hostPort = await publishedPort(n.wpContainer);
    if (hostPort) return { ...n, hostPort };
  }

  await createNetwork(n.networkName, { internal: false }).catch(() => {}); // already exists
  await execDocker(['volume', 'create', n.contentVolume]);

  if (!(await containerRunning(n.dbContainer))) {
    await execDocker(['rm', '-f', n.dbContainer]).catch(() => {});
    const r = await execDocker([
      'run', '-d', '--name', n.dbContainer, '--network', n.networkName,
      '--label', 'com.platform.production-standin=true',
      '-e', `MYSQL_ROOT_PASSWORD=${DB_PASSWORD}`,
      '-e', 'MYSQL_DATABASE=wordpress', '-e', 'MYSQL_USER=wp', '-e', `MYSQL_PASSWORD=${DB_PASSWORD}`,
      DB_IMAGE,
    ]);
    if (r.code !== 0) throw new Error(`production db container failed: ${r.stderr.trim()}`);
    await waitForMysql(n.dbContainer);
  }

  const hostPort = await freePort();
  await execDocker(['rm', '-f', n.wpContainer]).catch(() => {});
  const r = await execDocker([
    'run', '-d', '--name', n.wpContainer, '--network', n.networkName,
    '--label', 'com.platform.production-standin=true',
    '-p', `127.0.0.1:${hostPort}:80`,
    '-v', `${n.contentVolume}:/var/www/html`,
    '-e', `WORDPRESS_DB_HOST=${n.dbContainer}:3306`,
    '-e', 'WORDPRESS_DB_USER=wp', '-e', `WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`, '-e', 'WORDPRESS_DB_NAME=wordpress',
    WP_IMAGE,
  ]);
  if (r.code !== 0) throw new Error(`production wp container failed: ${r.stderr.trim()}`);
  await waitForHttp(hostPort);
  await installWordPress(n, hostPort);
  return { ...n, hostPort };
}

/**
 * A freshly-provisioned WORDPRESS_DB_* container has a reachable DB but no
 * installed site (no wp_options etc.) — wp-cli refuses nearly every command,
 * including `core update`, against an uninstalled site. Runs the same setup
 * the 5-minute install wizard does, once, so this stand-in is an actually
 * operable WordPress site and not just an empty shell.
 */
async function installWordPress(n: Omit<ProductionRuntime, 'hostPort'>, hostPort: number): Promise<void> {
  const check = await execDocker([
    'run', '--rm', '--network', n.networkName, '--volumes-from', n.wpContainer, '--user', WP_CONTENT_UID,
    '-e', `WORDPRESS_DB_HOST=${n.dbContainer}:3306`,
    '-e', 'WORDPRESS_DB_USER=wp', '-e', `WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`, '-e', 'WORDPRESS_DB_NAME=wordpress',
    CLI_IMAGE, 'wp', 'core', 'is-installed', '--path=/var/www/html',
  ]);
  if (check.code === 0) return; // already installed (persistent volume from a prior run)

  const r = await execDocker([
    'run', '--rm', '--network', n.networkName, '--volumes-from', n.wpContainer, '--user', WP_CONTENT_UID,
    '-e', `WORDPRESS_DB_HOST=${n.dbContainer}:3306`,
    '-e', 'WORDPRESS_DB_USER=wp', '-e', `WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`, '-e', 'WORDPRESS_DB_NAME=wordpress',
    CLI_IMAGE, 'wp', 'core', 'install',
    `--url=http://127.0.0.1:${hostPort}`, '--title=Platform Production Stand-in',
    '--admin_user=admin', `--admin_password=${DB_PASSWORD}`, '--admin_email=admin@example.test',
    '--skip-email', '--path=/var/www/html',
  ]);
  if (r.code !== 0) throw new Error(`wp core install failed: ${r.stderr.trim()}`);
}

export interface SnapshotResult {
  dbDumpPath: string;
  contentTarPath: string;
}

/** Real restore point: a mysqldump of the DB and a tar of wp-content, written to local disk. */
export async function takeSnapshot(environmentId: string, updateUnitId: string): Promise<SnapshotResult> {
  const runtime = await ensureProductionContainers(environmentId);
  const dir = path.join(SNAPSHOT_DIR, updateUnitId);
  await mkdir(dir, { recursive: true });

  const dbDumpPath = path.join(dir, 'db.sql');
  const dump = await execDocker(['exec', runtime.dbContainer, 'mysqldump', '-uroot', `-p${DB_PASSWORD}`, 'wordpress']);
  if (dump.code !== 0) throw new Error(`mysqldump failed: ${dump.stderr.trim()}`);
  await writeFile(dbDumpPath, dump.stdout, 'utf8');

  // Binary content: written straight to a bind-mounted host path by a throwaway
  // container instead of piped through execDocker's string-decoded stdout,
  // which would corrupt non-text bytes (images, etc).
  const contentTarPath = path.join(dir, 'wp-content.tar');
  const tar = await execDocker([
    'run', '--rm', '--volumes-from', runtime.wpContainer, '-v', `${dir}:/backup`, TAR_IMAGE,
    'tar', 'cf', '/backup/wp-content.tar', '-C', '/var/www/html', 'wp-content',
  ]);
  if (tar.code !== 0) throw new Error(`wp-content tar failed: ${tar.stderr.trim()}`);
  return { dbDumpPath, contentTarPath };
}

export interface PromoteResult {
  ok: boolean;
  detail: string;
}

/** Allow-lists for values that reach wp-cli argv: a flag (e.g. --exec=<php>) must never get through. */
export const COMPONENT_RE = /^(core|[a-z0-9][a-z0-9_-]{0,63})$/;
export const VERSION_RE = /^\d+(\.\d+){0,3}([-.][A-Za-z0-9]+)?$/;

/** Real promotion: runs an actual wp-cli update command against the persistent WP container. */
export async function promoteUpdate(environmentId: string, component: string, toVersion: string): Promise<PromoteResult> {
  if (!COMPONENT_RE.test(component) || !VERSION_RE.test(toVersion)) {
    return { ok: false, detail: 'refused: component/version failed validation' };
  }
  const runtime = await ensureProductionContainers(environmentId);
  // wordpress:cli's entrypoint only auto-prepends `wp` after probing `wp help <arg>`,
  // which itself fails (and so skips the prepend) on a site that isn't fully
  // installed yet — pass `wp` ourselves so exec always runs the real command.
  const cmd =
    component === 'core'
      ? ['wp', 'core', 'update', `--version=${toVersion}`, '--force']
      : ['wp', 'plugin', 'update', component];

  const r = await execDocker([
    'run', '--rm', '--network', runtime.networkName, '--volumes-from', runtime.wpContainer, '--user', WP_CONTENT_UID,
    '-e', `WORDPRESS_DB_HOST=${runtime.dbContainer}:3306`,
    '-e', 'WORDPRESS_DB_USER=wp', '-e', `WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`, '-e', 'WORDPRESS_DB_NAME=wordpress',
    CLI_IMAGE,
    ...cmd, '--path=/var/www/html',
  ]);
  const detail = (r.code === 0 ? r.stdout : r.stderr).trim().slice(0, 2000);
  return { ok: r.code === 0, detail };
}

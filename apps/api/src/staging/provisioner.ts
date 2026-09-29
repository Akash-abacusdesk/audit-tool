/**
 * Section-11 Safe Staging — D2 container lifecycle.
 *
 * Provisions a real, disposable WordPress+MySQL pair per staging run: its own
 * docker network, a MySQL container, a WordPress container reachable on a
 * host-assigned port. No production content exists in this checkout to
 * sanitize (that needs a real WP host — Phase 3, see docs/ops/phase3-readiness.md),
 * so this stands the environment up from the same fixture image the S6 CMS
 * battery already uses (cms-fixtures/images/cms-wordpress) — real containers,
 * real HTTP responses, just not real customer data.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { execDocker, createNetwork, removeNetwork } from '@platform/worker-runtime';

const WP_IMAGE = process.env.STAGING_WP_IMAGE ?? 'wordpress:6.6-apache@sha256:c30c1376b4d2c9d1e2328c2ee6149d133104d65873a98cbc6adc743a2964c4ba';
const DB_IMAGE = process.env.STAGING_DB_IMAGE ?? 'mysql:8@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d';
// ponytail: staging runs get a random per-run DB password (see provisionStagingContainers). This fixed
// one is only for update/production.ts's persistent stand-in, whose containers are reused across calls;
// the real production host replaces it (Phase 3).
export const DB_PASSWORD = 'staging-ephemeral';
/** Resource/privilege limits for the disposable containers (cap-drop is left off: the mysql/wordpress entrypoints chown and drop users). */
const LIMITS = ['--security-opt', 'no-new-privileges', '--memory', '1g', '--pids-limit', '512'];

export interface StagingRuntime {
  networkName: string;
  dbContainer: string;
  wpContainer: string;
  hostPort: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the OS for a free host port instead of guessing one. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

export async function waitForMysql(container: string, timeoutMs = 60_000, password = DB_PASSWORD): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await execDocker(['exec', container, 'mysqladmin', 'ping', '-h', 'localhost', `-p${password}`, '--silent']);
    if (r.code === 0) return;
    await sleep(1500);
  }
  throw new Error(`mysql in ${container} did not become ready within ${timeoutMs}ms`);
}

export async function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(1500);
  }
  throw new Error(`wordpress on port ${port} did not become ready within ${timeoutMs}ms`);
}

/** Stand up a fresh ephemeral WordPress+MySQL pair. Tears itself down on failure. */
export async function provisionStagingContainers(stagingId: string): Promise<StagingRuntime> {
  const networkName = `platform-stg-net-${stagingId}`;
  const dbContainer = `platform-stg-db-${stagingId}`;
  const wpContainer = `platform-stg-wp-${stagingId}`;
  const hostPort = await freePort();
  const runtime: StagingRuntime = { networkName, dbContainer, wpContainer, hostPort };
  const password = randomBytes(12).toString('hex');

  // Idempotent: a redelivered job finds the previous attempt's leftovers ("already exists") — clear them first.
  await destroyStagingContainers(runtime).catch(() => {});
  await createNetwork(networkName, { internal: false });
  try {
    let r = await execDocker([
      'run', '-d', '--name', dbContainer, '--network', networkName, ...LIMITS,
      '--label', 'com.platform.staging=true',
      '-e', `MYSQL_ROOT_PASSWORD=${password}`,
      '-e', 'MYSQL_DATABASE=wordpress',
      '-e', 'MYSQL_USER=wp',
      '-e', `MYSQL_PASSWORD=${password}`,
      DB_IMAGE,
    ]);
    if (r.code !== 0) throw new Error(`staging db container failed: ${r.stderr.trim()}`);

    await waitForMysql(dbContainer, 60_000, password);

    r = await execDocker([
      'run', '-d', '--name', wpContainer, '--network', networkName, ...LIMITS,
      '--label', 'com.platform.staging=true',
      '-p', `127.0.0.1:${hostPort}:80`,
      '-e', `WORDPRESS_DB_HOST=${dbContainer}:3306`,
      '-e', 'WORDPRESS_DB_USER=wp',
      '-e', `WORDPRESS_DB_PASSWORD=${password}`,
      '-e', 'WORDPRESS_DB_NAME=wordpress',
      WP_IMAGE,
    ]);
    if (r.code !== 0) throw new Error(`staging wordpress container failed: ${r.stderr.trim()}`);

    await waitForHttp(hostPort);
    return runtime;
  } catch (err) {
    await destroyStagingContainers(runtime).catch(() => {});
    throw err;
  }
}

/** Idempotent teardown — safe to call even if provisioning failed partway through. */
export async function destroyStagingContainers(runtime: StagingRuntime): Promise<void> {
  await execDocker(['rm', '-f', runtime.wpContainer]).catch(() => {});
  await execDocker(['rm', '-f', runtime.dbContainer]).catch(() => {});
  await removeNetwork(runtime.networkName).catch(() => {});
}

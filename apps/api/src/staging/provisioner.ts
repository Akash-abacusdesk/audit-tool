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
import { createServer } from 'node:net';
import { execDocker, createNetwork, removeNetwork } from '@platform/worker-runtime';

const WP_IMAGE = process.env.STAGING_WP_IMAGE ?? 'wordpress:6.6-apache';
const DB_IMAGE = process.env.STAGING_DB_IMAGE ?? 'mysql:8';
// ponytail: fixed password on a network scoped to this run alone, torn down with it — a
// secrets-manager-issued per-run credential is the upgrade if staging networks ever
// stop being single-tenant/ephemeral.
const DB_PASSWORD = 'staging-ephemeral';

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
async function freePort(): Promise<number> {
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

async function waitForMysql(container: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await execDocker(['exec', container, 'mysqladmin', 'ping', '-h', 'localhost', `-p${DB_PASSWORD}`, '--silent']);
    if (r.code === 0) return;
    await sleep(1500);
  }
  throw new Error(`mysql in ${container} did not become ready within ${timeoutMs}ms`);
}

async function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
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

  await createNetwork(networkName, { internal: false });
  try {
    let r = await execDocker([
      'run', '-d', '--name', dbContainer, '--network', networkName,
      '--label', 'com.platform.staging=true',
      '-e', `MYSQL_ROOT_PASSWORD=${DB_PASSWORD}`,
      '-e', 'MYSQL_DATABASE=wordpress',
      '-e', 'MYSQL_USER=wp',
      '-e', `MYSQL_PASSWORD=${DB_PASSWORD}`,
      DB_IMAGE,
    ]);
    if (r.code !== 0) throw new Error(`staging db container failed: ${r.stderr.trim()}`);

    await waitForMysql(dbContainer);

    r = await execDocker([
      'run', '-d', '--name', wpContainer, '--network', networkName,
      '--label', 'com.platform.staging=true',
      '-p', `127.0.0.1:${hostPort}:80`,
      '-e', `WORDPRESS_DB_HOST=${dbContainer}:3306`,
      '-e', 'WORDPRESS_DB_USER=wp',
      '-e', `WORDPRESS_DB_PASSWORD=${DB_PASSWORD}`,
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

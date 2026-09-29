import type { PgBoss } from 'pg-boss';
import { refreshTrivyDb } from '@platform/scanner';

const QUEUE = 'ops.trivy.db';

/**
 * Keeps the persistent trivy DB cache (TRIVY_CACHE_HOST_DIR) fresh, so scans never download inline (they run with
 * --skip-db-update). No-op when the variable is unset - scans then fall back to trivy's own per-run download.
 * Refreshes once at boot in the background (a cold pull can take many minutes on a slow link and must not delay
 * startup) and then on a daily pg-boss schedule (one replica runs each tick).
 */
export async function startTrivyDbRefresh(boss: PgBoss): Promise<void> {
  const cacheDir = process.env.TRIVY_CACHE_HOST_DIR;
  if (!cacheDir) return;
  const run = async (): Promise<void> => {
    try {
      const r = await refreshTrivyDb({ cacheDir, log: (m) => console.log(`[trivy-db] ${m}`) });
      if (r.updated) console.log(`[trivy-db] cache refreshed (${r.digest.slice(0, 12)})`);
    } catch (err) {
      console.error('[trivy-db] refresh failed (scans keep using the previous DB if any):', (err as Error).message);
      throw err;
    }
  };

  try {
    await boss.createQueue(QUEUE, { retryLimit: 3, retryDelay: 600, retryBackoff: true, expireInSeconds: 3600 });
  } catch {
    // already exists
  }
  try {
    await boss.schedule(QUEUE, process.env.TRIVY_DB_REFRESH_CRON ?? '17 4 * * *');
  } catch {
    // already scheduled
  }
  await boss.work(QUEUE, { pollingIntervalSeconds: 30 }, async () => run());
  void run().catch(() => {}); // boot-time refresh, off the startup path
}

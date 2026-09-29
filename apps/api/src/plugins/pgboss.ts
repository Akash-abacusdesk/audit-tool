import { PgBoss } from 'pg-boss';

export interface Boss {
  inner: PgBoss;
  stop(): Promise<void>;
}

/** Boot pg-boss (self-migrates its 'pgboss' schema) and return a thin handle. */
export async function startBoss(url: string, onError: (err: Error) => void): Promise<Boss> {
  const boss = new PgBoss({
    connectionString: url,
    schema: 'pgboss',
    // Every replica runs its own pool: keep it small so the bouncer/Postgres connection budget scales with replicas.
    max: Number(process.env.PGBOSS_POOL_MAX ?? 5),
    // Capacity-agnostic policy: queue sizing is env-tunable later, defaults are fine for S1.
  });
  boss.on('error', onError);
  await boss.start();
  return {
    inner: boss,
    stop: async () => {
      try {
        await boss.stop();
      } catch {
        // already stopped
      }
    },
  };
}

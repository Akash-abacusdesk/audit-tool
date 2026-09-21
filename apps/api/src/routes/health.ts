import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, ok } from '@platform/shared';

interface HealthDeps {
  pool: Pool;
  bossStarted: boolean;
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  console.log('[boot] plugin:health enter');
  app.get('/healthz', async () => ok({ status: 'live' }));

  app.get('/readyz', async () => {
    if (!deps.bossStarted) {
      throw new ApiError('UNAVAILABLE', 'pg-boss not started');
    }
    try {
      await deps.pool.query('SELECT 1');
    } catch {
      throw new ApiError('UNAVAILABLE', 'database unreachable');
    }
    return ok({ status: 'ready' });
  });
}

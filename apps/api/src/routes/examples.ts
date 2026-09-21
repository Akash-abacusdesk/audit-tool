import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import {
  ApiError,
  JOB,
  exampleCreateInput,
  exampleCreatedPayload,
  ok,
  type ExampleDto,
} from '@platform/shared';
import { withTx } from '../db/pool.js';
import { requirePermission } from '../auth/service.js';

interface ExampleDeps {
  pool: Pool;
  boss: PgBoss;
}

const ENDPOINT = 'POST /api/v1/examples';

function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export async function exampleRoutes(app: FastifyInstance, deps: ExampleDeps): Promise<void> {
  console.log('[boot] plugin:examples enter');
  /**
   * Reference endpoint — exercises every convention on purpose:
   * zod validation (422), idempotency-key replay, tx + queue-send-after-commit.
   * Copy this shape for new routes. See docs/api-conventions.md + db-conventions.md §3.
   */
  app.post('/examples', { preHandler: requirePermission('example.create') }, async (req, reply) => {
    const parsed = exampleCreateInput.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'invalid request body', parsed.error.flatten());
    }

    const key = req.headers['idempotency-key'];
    const fp = fingerprint(parsed.data);

    // Phase 1 — inside one tx: reserve the idempotency key (if any), write business row.
    const created = await withTx(deps.pool, async (tx) => {
      const hasKey = typeof key === 'string' && key.length > 0;
      if (hasKey) {
        const reserved = await tx.query<{ request_fingerprint: string; response_body: unknown }>(
          `INSERT INTO api_idempotency_keys
             (endpoint, key, request_fingerprint, status_code, response_body)
           VALUES ($1, $2, $3, 201, 'null'::jsonb)
           ON CONFLICT (endpoint, key) DO NOTHING
           RETURNING request_fingerprint, response_body`,
          [ENDPOINT, key, fp]
        );
        if (reserved.rowCount === 0) {
          // Key taken: our INSERT waited on the winner's tx — its row is readable now.
          const existing = await tx.query<{
            status_code: number;
            response_body: ExampleDto;
            request_fingerprint: string;
          }>(
            'SELECT status_code, response_body, request_fingerprint FROM api_idempotency_keys WHERE endpoint = $1 AND key = $2',
            [ENDPOINT, key]
          );
          const row = existing.rows[0];
          if (!row) throw new ApiError('CONFLICT', 'idempotency key in flight');
          if (row.request_fingerprint !== fp) {
            throw new ApiError('CONFLICT', 'idempotency key reused with a different request body');
          }
          reply.header('Idempotency-Replayed', 'true');
          return { replay: row.response_body as ExampleDto };
        }
      }

      const inserted = await tx.query<{ id: string; name: string; created_at: Date }>(
        'INSERT INTO api_examples (name) VALUES ($1) RETURNING id::text, name, created_at',
        [parsed.data.name]
      );
      const r = inserted.rows[0]!;
      const dto: ExampleDto = {
        id: r.id,
        name: r.name,
        createdAt: r.created_at.toISOString(),
      };
      if (hasKey) {
        await tx.query(
          'UPDATE api_idempotency_keys SET status_code = 201, response_body = $3 WHERE endpoint = $1 AND key = $2',
          [ENDPOINT, key, JSON.stringify(dto)]
        );
      }
      return { dto };
    });

    if ('replay' in created) return reply.status(201).send(ok(created.replay));

    // Phase 2 — after commit: enqueue. At-least-once delivery; workers must be idempotent.
    await deps.boss.send(JOB.exampleCreated, exampleCreatedPayload.parse(created.dto));

    return reply.status(201).send(ok(created.dto));
  });

  app.get('/examples/:id', { preHandler: requirePermission('example.read') }, async (req) => {
    const { id } = req.params as { id: string };
    try {
      const found = await deps.pool.query<ExampleDto & { created_at: Date }>(
        'SELECT id::text, name, created_at FROM api_examples WHERE id = $1',
        [id]
      );
      const row = found.rows[0];
      if (!row) throw new ApiError('NOT_FOUND', `example ${id} not found`);
      return ok({ id: row.id, name: row.name, createdAt: row.created_at.toISOString() });
    } catch (err) {
      // invalid uuid text → postgres 22P02 → same answer as "not here"
      if ((err as { code?: string }).code === '22P02') {
        throw new ApiError('NOT_FOUND', `example ${id} not found`);
      }
      throw err;
    }
  });
}

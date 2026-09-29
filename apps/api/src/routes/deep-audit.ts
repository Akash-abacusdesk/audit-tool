import { isAbsolute, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  ApiError,
  deepAuditTarget,
  isProductionTarget,
  ok,
  DEEP_AUDIT_STAGES,
  type DeepAuditTarget,
} from '@platform/shared';
import { recordAudit } from '../auth/audit.js';
import { requirePermission } from '../auth/service.js';
import { assertProjectScope } from '../auth/scope.js';
import { DeepAuditQueue, InMemoryDeepAuditStore, type DeepAuditStore } from '../deep-audit/queue.js';
import { PgDeepAuditStore } from '../deep-audit/pg-store.js';

function isUnderRoot(p: string, root: string | undefined): boolean {
  if (!root) return false;
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isAllowedTargetHost(url: string, allowed: string | undefined): boolean {
  const hosts = (allowed ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface Deps {
  pool: import('pg').Pool;
  boss: PgBoss;
}

/** Durable deep-audit run store, api_deep_audit_runs (migration 009). Bound to a real pool on route registration. */
export let deepAuditStore: DeepAuditStore = new InMemoryDeepAuditStore();

export async function deepAuditRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  console.log('[boot] plugin:deep-audit enter');
  deepAuditStore = new PgDeepAuditStore(deps.pool);

  // ---- Enqueue the serialized 7-stage pipeline (refuses production) ----
  app.post(
    '/deep-audit/run',
    { preHandler: requirePermission('audit.deep') },
    async (req, reply) => {
      const parsed = deepAuditTarget.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError('VALIDATION_ERROR', 'invalid deep-audit target', parsed.error.flatten());
      }
      const target = parsed.data as DeepAuditTarget;
      // Hard gate: no deep-audit step may touch a live production host.
      if (isProductionTarget(target)) {
        throw new ApiError('VALIDATION_ERROR', 'deep-audit may not target a production environment');
      }

      await assertProjectScope(req, target.projectId, target.environmentId, 'audit.deep.enqueue', 'audit.deep');
      // Client-supplied host paths are mounted into scanner containers: confine them to one configured root (fail closed).
      for (const p of [target.workspaceDir, target.clonePath]) {
        if (p !== undefined && !isUnderRoot(p, process.env.DEEP_AUDIT_WORKSPACE_ROOT)) {
          throw new ApiError('VALIDATION_ERROR', 'workspaceDir/clonePath must be under DEEP_AUDIT_WORKSPACE_ROOT');
        }
      }
      // ZAP/testssl actively probe targetUrl: only hosts the operator listed may be scanned (fail closed when unset).
      if (target.targetUrl !== undefined && !isAllowedTargetHost(target.targetUrl, process.env.DEEP_AUDIT_ALLOWED_HOSTS)) {
        throw new ApiError('VALIDATION_ERROR', 'targetUrl host is not in DEEP_AUDIT_ALLOWED_HOSTS');
      }
      const auditId = await deepAuditStore.create(target);
      const queue = new DeepAuditQueue(deps.boss, deepAuditStore);
      // enqueuePipeline dispatches only the first stage; each stage chains to
      // the next itself (queue.ts) — the pipeline still runs all 7 in order.
      await queue.enqueuePipeline(auditId, target);

      await recordAudit(deps.pool, {
        actorId: req.actor!.user.id,
        action: 'audit.deep.enqueue',
        result: 'allow',
        projectId: target.projectId,
        environmentId: target.environmentId,
        resource: `deep-audit:${auditId}`,
        requestId: req.id,
        details: { stages: DEEP_AUDIT_STAGES.length, environment: target.environment },
      });

      return reply.status(202).send(
        ok({ auditId, stages: DEEP_AUDIT_STAGES.length, environment: target.environment, queued: true })
      );
    }
  );

  // ---- Fetch the aggregated report for a run ----
  app.get(
    '/deep-audit/:id',
    { preHandler: requirePermission('audit.deep') },
    async (req) => {
      const { id } = req.params as { id: string };
      const entry = await deepAuditStore.get(id);
      if (!entry) throw new ApiError('NOT_FOUND', `deep-audit run ${id} not found`);
      await assertProjectScope(req, entry.target.projectId, entry.target.environmentId, 'audit.deep.read', 'audit.deep');
      if (!entry.report) return ok({ auditId: id, status: 'queued' });
      return ok(entry.report);
    }
  );

  console.log('[boot] plugin:deep-audit exit');
}

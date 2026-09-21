/**
 * Wire-format envelopes shared by every HTTP API and the portal frontend.
 * See docs/api-conventions.md.
 */
import { z } from 'zod';
export function ok(data) {
    return { ok: true, data };
}
export function fail(code, message, details, requestId) {
    return { ok: false, error: { code, message, details, requestId } };
}
// ---- Example resource (reference contract exercising all conventions) ----
export const exampleCreateInput = z.object({
    name: z.string().min(1).max(200),
});
// ---- Cursor pagination (list endpoints) ----
export const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
    cursor: z.string().optional(),
});
// ---- Auth, users & RBAC (Section 2) — see docs/api-conventions.md ----
const slug = z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters/digits separated by single dashes');
export const loginInput = z.object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
});
/** One-time bootstrap: only accepted while zero users exist. */
export const bootstrapInput = loginInput.extend({
    displayName: z.string().min(1).max(100),
    orgName: z.string().min(1).max(100),
    orgSlug: slug,
});
export const userCreateInput = z.object({
    email: z.string().email(),
    password: z.string().min(12).max(200),
    displayName: z.string().min(1).max(100),
});
export const roleBindingCreateInput = z.object({
    userId: z.string().uuid(),
    role: z.enum(['manager', 'team_lead', 'project_coordinator', 'developer', 'security_admin']),
    orgId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    environmentId: z.string().uuid().optional(),
});
export const orgCreateInput = z.object({ name: z.string().min(1).max(100), slug });
export const projectCreateInput = z.object({
    orgId: z.string().uuid(),
    name: z.string().min(1).max(100),
    slug,
});
export const environmentCreateInput = z.object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(100),
});
export const userUpdateInput = z.object({ isActive: z.boolean() });
export const passwordChangeInput = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(12).max(200),
});
export const auditListQuery = listQuery.extend({
    actorId: z.string().uuid().optional(),
    action: z.string().min(1).max(100).optional(),
    result: z.enum(['allow', 'deny', 'error']).optional(),
    orgId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    environmentId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
});

/**
 * Wire-format envelopes shared by every HTTP API and the portal frontend.
 * See docs/api-conventions.md.
 */
import { z } from 'zod';
import type { Role } from './rbac.js';

/** Canonical UUID v4-shaped check — every route validating a path/body id uses this one pattern. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}


export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  details?: unknown,
  requestId?: string
): ApiFailure {
  return { ok: false, error: { code, message, details, requestId } };
}

// ---- Example resource (reference contract exercising all conventions) ----

export const exampleCreateInput = z.object({
  name: z.string().min(1).max(200),
});

export type ExampleCreateInput = z.infer<typeof exampleCreateInput>;

export interface ExampleDto {
  id: string;
  name: string;
  createdAt: string;
}

// ---- Cursor pagination (list endpoints) ----

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).optional(),
  cursor: z.string().optional(),
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
}

export interface SessionDto {
  token: string; // bearer; shown once at login
  expiresAt: string;
  user: UserDto;
}

export interface RoleBindingDto {
  id: string;
  userId: string;
  role: Role;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  createdAt: string;
}

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface EnvironmentDto {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

export interface MeResponse {
  user: UserDto;
  bindings: RoleBindingDto[];
}

export interface AuditEventDto {
  id: string;
  actorId: string | null;
  action: string;
  result: 'allow' | 'deny' | 'error';
  orgId: string | null;
  projectId: string | null;
  environmentId: string | null;
  resource: string | null;
  requestId: string | null;
  details: unknown;
  createdAt: string;
}

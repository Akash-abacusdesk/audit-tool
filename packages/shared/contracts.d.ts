/**
 * Wire-format envelopes shared by every HTTP API and the portal frontend.
 * See docs/api-conventions.md.
 */
import { z } from 'zod';
import type { Role } from './rbac.js';
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
export declare function ok<T>(data: T): ApiSuccess<T>;
export declare function fail(code: string, message: string, details?: unknown, requestId?: string): ApiFailure;
export declare const exampleCreateInput: z.ZodObject<{
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
}, {
    name: string;
}>;
export type ExampleCreateInput = z.infer<typeof exampleCreateInput>;
export interface ExampleDto {
    id: string;
    name: string;
    createdAt: string;
}
export declare const listQuery: z.ZodObject<{
    limit: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
    cursor?: string | undefined;
}, {
    limit?: number | undefined;
    cursor?: string | undefined;
}>;
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}
export declare const loginInput: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
}, {
    email: string;
    password: string;
}>;
/** One-time bootstrap: only accepted while zero users exist. */
export declare const bootstrapInput: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
} & {
    displayName: z.ZodString;
    orgName: z.ZodString;
    orgSlug: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
    displayName: string;
    orgName: string;
    orgSlug: string;
}, {
    email: string;
    password: string;
    displayName: string;
    orgName: string;
    orgSlug: string;
}>;
export declare const userCreateInput: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
    displayName: z.ZodString;
}, "strip", z.ZodTypeAny, {
    email: string;
    password: string;
    displayName: string;
}, {
    email: string;
    password: string;
    displayName: string;
}>;
export declare const roleBindingCreateInput: z.ZodObject<{
    userId: z.ZodString;
    role: z.ZodEnum<["manager", "team_lead", "project_coordinator", "developer", "security_admin"]>;
    orgId: z.ZodString;
    projectId: z.ZodOptional<z.ZodString>;
    environmentId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    userId: string;
    role: "manager" | "team_lead" | "project_coordinator" | "developer" | "security_admin";
    orgId: string;
    projectId?: string | undefined;
    environmentId?: string | undefined;
}, {
    userId: string;
    role: "manager" | "team_lead" | "project_coordinator" | "developer" | "security_admin";
    orgId: string;
    projectId?: string | undefined;
    environmentId?: string | undefined;
}>;
export declare const orgCreateInput: z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    slug: string;
}, {
    name: string;
    slug: string;
}>;
export declare const projectCreateInput: z.ZodObject<{
    orgId: z.ZodString;
    name: z.ZodString;
    slug: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    orgId: string;
    slug: string;
}, {
    name: string;
    orgId: string;
    slug: string;
}>;
export declare const environmentCreateInput: z.ZodObject<{
    projectId: z.ZodString;
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    projectId: string;
}, {
    name: string;
    projectId: string;
}>;
export declare const userUpdateInput: z.ZodObject<{
    isActive: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    isActive: boolean;
}, {
    isActive: boolean;
}>;
export declare const passwordChangeInput: z.ZodObject<{
    currentPassword: z.ZodString;
    newPassword: z.ZodString;
}, "strip", z.ZodTypeAny, {
    currentPassword: string;
    newPassword: string;
}, {
    currentPassword: string;
    newPassword: string;
}>;
export declare const auditListQuery: z.ZodObject<{
    limit: z.ZodOptional<z.ZodDefault<z.ZodNumber>>;
    cursor: z.ZodOptional<z.ZodString>;
} & {
    actorId: z.ZodOptional<z.ZodString>;
    action: z.ZodOptional<z.ZodString>;
    result: z.ZodOptional<z.ZodEnum<["allow", "deny", "error"]>>;
    orgId: z.ZodOptional<z.ZodString>;
    projectId: z.ZodOptional<z.ZodString>;
    environmentId: z.ZodOptional<z.ZodString>;
    from: z.ZodOptional<z.ZodDate>;
    to: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    limit?: number | undefined;
    cursor?: string | undefined;
    orgId?: string | undefined;
    projectId?: string | undefined;
    environmentId?: string | undefined;
    actorId?: string | undefined;
    action?: string | undefined;
    result?: "allow" | "deny" | "error" | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
}, {
    limit?: number | undefined;
    cursor?: string | undefined;
    orgId?: string | undefined;
    projectId?: string | undefined;
    environmentId?: string | undefined;
    actorId?: string | undefined;
    action?: string | undefined;
    result?: "allow" | "deny" | "error" | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
}>;
export interface UserDto {
    id: string;
    email: string;
    displayName: string;
    isActive: boolean;
    createdAt: string;
}
export interface SessionDto {
    token: string;
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

/**
 * RBAC core: roles, permissions, scope model, default-deny resolver.
 * Shared by API (enforcement) and portal (UI gating) so both sides agree.
 *
 * Scope model — bindings are nested; a binding grants its role's permissions
 * within everything it contains (org ⊇ projects ⊇ environments):
 *   { orgId }                          → whole organization
 *   { orgId, projectId }               → all environments of one project
 *   { orgId, projectId, environmentId} → a single environment
 *
 * Default-deny: permissionsFor returns only explicitly granted permissions;
 * anything unmatched is denied by construction.
 */
export declare const ROLES: readonly ["manager", "team_lead", "project_coordinator", "developer", "security_admin"];
export type Role = (typeof ROLES)[number];
export declare const PERMISSIONS: readonly ["org.manage", "project.manage", "user.manage", "role.assign", "audit.read", "example.create", "example.read", "git.manage", "git.read", "finding.read", "finding.update", "scan.ingest", "scheduler.read", "scheduler.manage"];
export type Permission = (typeof PERMISSIONS)[number];
/**
 * Starter matrix (Section-2 baseline, tighten per PRD reviews).
 * Separation of duties: security_admin holds only security administration
 * (no business permissions); user management lives with security_admin alone.
 */
export declare const ROLE_PERMISSIONS: Record<Role, readonly Permission[]>;
export declare function permissionsOfRole(role: Role): readonly Permission[];
/** A resolved binding as seen by the resolver (DB rows map 1:1). */
export interface RoleBindingView {
    role: Role;
    orgId: string;
    projectId: string | null;
    environmentId: string | null;
}
/** The scope an action targets. Omit projectId/environmentId for org-level ops. */
export interface ScopeRef {
    orgId: string;
    projectId?: string | null;
    environmentId?: string | null;
}
/** All permissions the bindings grant at the given target scope. Default-deny. */
export declare function permissionsFor(bindings: readonly RoleBindingView[], target: ScopeRef): Set<Permission>;
export declare function can(bindings: readonly RoleBindingView[], target: ScopeRef, perm: Permission): boolean;

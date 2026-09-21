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
export const ROLES = [
    'manager',
    'team_lead',
    'project_coordinator',
    'developer',
    'security_admin',
];
export const PERMISSIONS = [
    'org.manage',
    'project.manage',
    'user.manage',
    'role.assign',
    'audit.read',
    'example.create',
    'example.read',
    // Section-3 git plane (S3-D1): connections/repo links/stack detections/
    // policy assignments. manage = write ops, read = portal visibility.
    'git.manage',
    'git.read',
    // Section-5 scanning plane (S5-D1): normalized findings + scan runs.
    // read = portal visibility; update = lifecycle triage (status/assignment);
    // ingest = scanning pipeline writing results (machine/security context).
    'finding.read',
    'finding.update',
    'scan.ingest',
    // Section-4A scheduler plane: telemetry visibility + job ops (enqueue
    // demo/cancel). Global resource — coarse gate only, no scope re-check.
    'scheduler.read',
    'scheduler.manage',
];
/**
 * Starter matrix (Section-2 baseline, tighten per PRD reviews).
 * Separation of duties: security_admin holds only security administration
 * (no business permissions); user management lives with security_admin alone.
 */
export const ROLE_PERMISSIONS = {
    manager: ['org.manage', 'project.manage', 'audit.read', 'example.create', 'example.read', 'git.manage', 'git.read', 'scheduler.read', 'scheduler.manage', 'finding.read', 'finding.update', 'scan.ingest'],
    team_lead: ['project.manage', 'role.assign', 'example.create', 'example.read', 'git.manage', 'git.read', 'finding.read', 'finding.update', 'scan.ingest'],
    project_coordinator: ['example.create', 'example.read', 'git.read', 'finding.read'],
    developer: ['example.read', 'git.read', 'finding.read'],
    security_admin: ['user.manage', 'role.assign', 'audit.read', 'scheduler.read', 'scheduler.manage', 'finding.read', 'finding.update', 'scan.ingest'],
};
export function permissionsOfRole(role) {
    return ROLE_PERMISSIONS[role];
}
function bindingCovers(b, t) {
    if (b.orgId !== t.orgId)
        return false;
    // A project/env-scoped binding never applies to an org-level operation.
    if (!t.projectId && b.projectId)
        return false;
    if (b.projectId && b.projectId !== t.projectId)
        return false;
    if (!t.environmentId && b.environmentId)
        return false;
    if (b.environmentId && b.environmentId !== t.environmentId)
        return false;
    return true;
}
/** All permissions the bindings grant at the given target scope. Default-deny. */
export function permissionsFor(bindings, target) {
    const granted = new Set();
    for (const b of bindings) {
        if (!bindingCovers(b, target))
            continue;
        for (const p of permissionsOfRole(b.role))
            granted.add(p);
    }
    return granted;
}
export function can(bindings, target, perm) {
    return permissionsFor(bindings, target).has(perm);
}

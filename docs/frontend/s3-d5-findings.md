# S3-D5 findings — portal Git/onboarding UI (angela)

Contract gaps and observations discovered while building the Section 3 UI on `feature/s3-ui`
(off main `b27f51e`). None blocked implementation — workarounds are live in the UI; jim
folds these into his S3-D1B queue as he sees fit.

1. **No list endpoints for orgs/projects/environments.** `GET /orgs|/projects|/environments`
   do not exist. All pickers derive scopes from own role bindings plus objects created in
   the current session. Works, but a user with org-level `project.manage` cannot see or
   select projects they didn't create/bind to. Highest-value gap for onboarding UX.

2. **Write-permission split across git plane.** POST `/repo-links` and
   `/stack-detections` enforce `project.manage` scope checks; only connections and
   policy assignments check pure `git.manage`. UI gates writes accordingly (checks both).
   If intentional (SoD), document it; if not, unify on `git.manage`.

3. **Policy catalog is implicit.** `PolicyAssignmentDto.policyId` is an opaque string;
   dwight's mapper vocabulary (`nextjs|wordpress|payload|directus|strapi|unknown`) is the
   de-facto catalog. Portal hardcodes that list. A served catalog endpoint would prevent drift.

4. **`GET /stack-detections` has no cursor paging** (fixed limit window, latest-first).
   Fine for portal history view; flagging so nobody builds a long-history UI against it.

5. **Connection list is orgId-mandatory** (no cross-org listing). Consistent with the
   scope model — noted so future "all my connections" features know the contract.

6. **Revoked connections remain listed** by design (soft revoke). Portal renders them
   distinctly; audit trail preserved server-side.

---

Live-E2E additions (2026-08-25, main `3dcda7e` + stack up):

7. **BUG (jim/kevin queue): `GET /repo-links?projectId=` returns 500.** `keysetPage`
   builds `ORDER BY created_at` unqualified; the repo-links query JOINs
   `api_repo_links` with `api_git_connections`, both of which have `created_at`
   → PG `42702 column reference "created_at" is ambiguous`. Single-table keyset
   users (connections list) unaffected. Create-side (`POST /repo-links`) verified
   working; portal repos tab cannot list until fixed.

8. **Second-org chicken-and-egg.** Bootstrap binds roles to the bootstrap org only.
   A manager can CREATE another org (coarse `org.manage` passes) but holds no
   binding ON the new org → every scoped op inside it 403s (`assertScope`)
   until a security_admin grants `/role-bindings`. Onboarding UI should either
   auto-bind creator→new org or route users to the bootstrap-org flow first.

9. **Admin-plane gates apply to onboarding writes** (pam S2-D2): `/orgs|/projects|
   /environments` require management-network origin + fresh password step-up
   (`POST /auth/step-up`). Portal flows that create scopes must handle the
   step-up prompt or surface a clear denial; silent 403s read as bugs. E2E now
   performs step-up explicitly before onboarding steps.

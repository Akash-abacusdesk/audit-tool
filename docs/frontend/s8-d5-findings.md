# S8-D5 — JIT request & approval UI (findings)

Status: **built against the FINAL Jim S8-D1 contract** (converged in
`tool` commit `1cb1568`, "fix(s8): converge S8-D1 contract to Angela's S8-D5
findings"). Jim aligned S8-D1 to the shapes proposed in the original S8-D5
findings doc, so the UI now targets the canonical API directly. No PRD-derived
or DEMO fallback remains.

## Canonical contract (S8-D1, `@platform/shared` `jit.ts` + `routes/jit.ts`)

Envelope: every response is `{ ok, data }` (matches Dwight's prodcomms).

| Method & path | perm | success | data |
| --- | --- | --- | --- |
| `POST /api/v1/jit/requests` | `jit.request` | 202 | `{ request_id }` |
| `POST /api/v1/jit/requests/:id/approve` | `jit.approve` | 200 | `{ request_id, token, redemption_code }` |
| `POST /api/v1/jit/requests/:id/reject` | `jit.approve` | 200 | `{ request_id, status: 'rejected' }` |
| `POST /api/v1/jit/redeem` | — (no session) | 200 | `{ grant_id, ttl_seconds, requester, site_id }` |
| `POST /api/v1/jit/grants/:grantId/revoke` | `jit.revoke` | 200 | `{ grant_id, status: 'revoked' }` |
| `GET /api/v1/jit/requests?status=` | `jit.request` | 200 | `JitRequestDto[]` (optional `?status=` filter) |
| `GET /api/v1/jit/grants` | `jit.approve` | 200 | `JitGrantDto[]` |

### DTOs
- `JitRequestInput`: `{ site_id:string, reason:string, duration_minutes:int(1..10080), scope?:{ orgId:uuid, projectId?:uuid, environmentId?:uuid } }`
- `JitRequestDto`: `{ id, site_id, reason, duration_minutes, status:pending|approved|rejected|expired, created_by, created_at, expires_at, approved_at }`
- `JitGrantDto`: `{ grant_id, ttl_seconds, requester, site_id, status:active|consumed|expired|revoked, issued_at, expires_at }`
- Redeem body is `{ request_id, token_hash }` where `token_hash` is the SHA-256
  (hex) of the opaque `redemption_code` shown once at approval.

### Permissions (`rbac.ts`)
- `jit.request` → developer, team_lead, manager
- `jit.approve` → team_lead, manager, security_admin
- `jit.revoke` → team_lead, manager, security_admin

## UI behavior (`apps/portal/src/app/(portal)/jit`)
- Gated on `canAnywhere(me,'jit.request')`; approval actions gated on
  `jit.approve`; revoke gated on `jit.revoke`.
- Three tabs: **Request access** (POST /requests), **Approvals**
  (approve/reject by id, shows the one-time `redemption_code`), **My grants**
  (redeem a token via Web Crypto SHA-256, revoke by id).
- The redemption token is shown exactly once at approval and must be relayed to
  the WordPress plugin (Kevin S8-D4), which performs `/jit/redeem`.

## Known gap — RESOLVED (S8-D5, authorized by god 2026-08-28)
The original contract exposed **no list (GET) endpoints**, so the UI kept an
*in-session* record of what this browser created/approved/redeemed. God
authorized adding two read-only handlers to `apps/api/src/routes/jit.ts` (Jim
signed off idle; `shared/rbac.ts` untouched, perms already present), so the
approval/grant queues are now server-backed:

- `GET /api/v1/jit/requests` (`jit.request`, optional `?status=` filter) → `JitRequestDto[]`
- `GET /api/v1/jit/grants` (`jit.approve`) → `JitGrantDto[]`

The portal `Approvals` and `My grants` tabs now load from these on mount and
refetch after each action; the request form reloads the pending queue on submit.
No write contract or shared types were changed.

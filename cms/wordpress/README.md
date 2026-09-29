# S8-D4 — WordPress MU-plugin: signed mutation events + temporary JIT admin sessions

WordPress owner deliverable for Section 8 (XL: WordPress Monitoring & JIT). One
MU-plugin (`mu-plugins/s8-monitor.php` + `mu-plugins/s8-lib/*`) that:

1. Emits **signed, async HTTPS mutation events** for every privileged human
   action on the site (admin/role changes, plugin install/activate/deactivate/
   update/delete, core updates, JIT session create/revoke).
2. Implements **temporary WordPress sessions** (short-lived administrators,
   auto-revoked, hash-only token storage).
3. Implements the **JIT WP-side** logic: request / approval / one-time
   redemption hooks against the central plane (Jim's S8-D1 ingest + JIT API).

The schema + redemption contract is the single source of truth:
[`contracts/wp-events.schema.json`](contracts/wp-events.schema.json). The signing
primitives mirror `apps/api/src/routes/webhooks.ts` exactly (HMAC-SHA256 over
raw JSON bytes), so the central ingest can verify with `node:crypto` and a
TypeScript verifier proves the scheme end-to-end (`tool/tests/unit/cms/wp-events.test.ts`).

## Drop-in

Copy `mu-plugins/s8-monitor.php` **and** the `mu-plugins/s8-lib/` directory into
the site's `wp-content/mu-plugins/`. WordPress auto-loads the top-level file; it
`require`s the two libs.

## Configuration (wp-config.php or environment)

| Constant / env            | Purpose                                                      | Required |
|---------------------------|--------------------------------------------------------------|----------|
| `S8_WP_EVENT_SECRET`      | Shared HMAC secret (must match central ingest)               | yes      |
| `S8_EVENT_INGEST_URL`     | Central ingest endpoint — canonical path `https://plane/api/v1/wp/mutation-events` (set this) | yes  |
| `S8_WP_SITE_ID`           | `deployment_id` of this managed site                        | yes      |
| `S8_CENTRAL_BASE_URL`     | Central base for JIT redeem/request (e.g. `https://plane`)  | for JIT  |

If the secret or ingest URL is missing, emission is skipped (fail-closed, no
unauthenticated events).

## Signed event envelope

```
POST {S8_EVENT_INGEST_URL}            # canonical: /api/v1/wp/mutation-events
Content-Type: application/json
X-WP-Signature: sha256=<hmac-sha256 hex>   # also accepted (case-insensitive): x-wp-signature
X-WP-Delivery:  <uuid delivery_id>
X-WP-Site:      <site_id>                  # optional; central reads site_id from the envelope body
<body = canonical JSON of the event>
```

- `signature = HMAC-SHA256( rawJsonBody, S8_WP_EVENT_SECRET )`, lowercase hex.
- Replay protection is twofold: an **advisory** freshness window on `occurred_at`
  (central rejects stale deliveries; mirrors `WEBHOOK_MAX_AGE_MIN`) and an
  **authoritative** dedup on `(site_id, delivery_id)` server-side (PRD §12.3
  untrusted-input posture — a compromised site must not pivot into central RCE).
- WP stores nothing but the signature; events are fire-and-forget (`blocking=false`).

See `contracts/wp-events.schema.json` for the full field/enum list.

## JIT WP-side

- **Request:** `POST /wp-json/s8/v1/jit/request { reason, duration_minutes }`
  (requires `manage_options`) → central `POST /api/v1/jit/requests` → `202 { request_id }`.
  Human approval happens server-side in central.
- **Redeem (one-time):** central issues an opaque one-time token after approval;
  `POST /wp-json/s8/v1/jit/redeem { token, request_id }` → central
  `POST /api/v1/jit/redeem { token, request_id }` (central hashes it; `token_hash` is refused) →
  `200 { grant_id, ttl_seconds, requester }`. Central marks the token consumed
  atomically. WP provisions a temporary `administrator`, stores **only**
  `token_hash` (hash-only storage), and schedules a single-fire `s8_jit_expire_user`
  cron to auto-revoke. Every JIT session create/revoke is itself a signed
  `wp.jit.session_*` mutation event.

No shared/permanent admin password exists anywhere (PRD 2.1(5), §11.2).

## Integration with Jim's S8-D1 (final, confirmed)

Jim's S8-D1 ingest (branch `feature/s8-d1`) implements the contract as specified,
with these confirmed deltas (see inbox `2026-08-28T09-00-01-000Z-jim-kevin`):

- **Canonical ingest path: `POST /api/v1/wp/mutation-events`** (Dwight's S8-D2
  transport name, chosen by god f1c8f8 as the single shared path). Set
  `S8_EVENT_INGEST_URL` to this — no code change in the plugin.
- **Signature header: both `x-wp-signature` and `X-WP-Signature` are accepted.**
  Algorithm identical: HMAC-SHA256 over raw body, `sha256=<hex>`, `timingSafeEqual`.
- **`site_id` is read from the envelope body** (the `wpEventEnvelope` in
  `@platform/shared`); the plugin's `X-WP-Site` header is accepted but optional.
- **Freshness:** `x-wp-ts` (~60s) OR the envelope `occurred_at` is accepted.
- Envelope body schema = `wp-mutation-events/1.0`, all 11 event types.
- **JIT redeem endpoint unchanged:** `POST /api/v1/jit/redeem`
  `{ token_hash, request_id }` → `{ grant_id, ttl_seconds, requester }`; central
  marks the token consumed atomically. JIT request endpoint `POST /api/v1/jit/requests`
  unchanged. Oscar's S8-D6 runs its tests against `feature/s8-d1`.

All central URLs remain configurable; the plugin is unchanged except the
`S8_EVENT_INGEST_URL` value operators set.

## S10-D4 — WordPress inventory endpoint

The MU-plugin also exposes a reliable, signed inventory pull so the central
plane can collect core/plugin/theme versions for CVE correlation (Dwight S10-D3)
without running WPScan on the live host (PRD §10, line 640-642).

- **Endpoint:** `POST /wp-json/s8/v1/inventory` (signed, same `S8_WP_EVENT_SECRET`
  HMAC scheme as mutation events — `s8_verify_event`). Only the central plane
  holds the secret, so version metadata is never world-readable. Fail-closed
  (401 on bad signature, 503 if signing unconfigured).
- **Implementation:** `s8_collect_inventory()` uses only WordPress-native APIs —
  `get_bloginfo('version')` (core), `get_plugins()` (plugins, with active state
  from `active_plugins`), `wp_get_themes()` (themes, active = current stylesheet).
- **Emitted shape:** `wp-inventory/1.0` — `{ site_id, collected_at, core.version,
  plugins[{name,slug,version,active}], themes[{name,slug,version,active}] }`.
- **Central consumer:** `tool/cms/wordpress/inventory.ts` — `parseWordPressInventory`
  (zod-validated, fail-closed), `inventoryComponents()` (flat core/plugin/theme
  list for correlation), and `buildInventoryRequest()` (signed request helper
  mirroring the PHP HMAC). DTO agreed with Dwight (S10-D3) via hive outbox.
- Fixtures: `tests/fixtures/wordpress-inventory.{sample,vulnerable}.json`
  (the `vulnerable` one carries a known-old plugin version for Oscar S10-D6).


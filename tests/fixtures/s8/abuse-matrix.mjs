// S8-D6 abuse matrix (D6 / oscar). Two surfaces the GO calls out:
//   1) webhook replay / forged / huge-payload — against the S3 git-webhook route,
//      re-validated in the Section 8 monitoring/JIT context.
//   2) JIT (just-in-time access) replay / token-reuse / expiry / revocation —
//      against the not-yet-landed S8-D1 ingestion + S8-D4 MU-plugin/JIT state.
//
// Endpoints reconciled to Jim's S8-D1 canonical shapes: POST /api/v1/wp/mutation-events
// (HMAC x-wp-signature, dedup delivery_id) and /api/v1/jit/requests/:id/redeem (one-time
// redemption; /api/v1/jit/grants/:id/revoke for revocation). Live battery gated on env
// (S8_WEBHOOK_BASE_URL + S8_JIT_BASE_URL). Error code + exact JIT token shape are
// flip-points the live run reconciles. Sandbox proofs below do NOT depend on them.
//
// `expects.rejected` = the abuse case must be denied (no side effect). For webhook
// `replay`, rejection is the DB unique-index dedupe (accepted-once envelope), not a
// 4xx — captured in `expects.replayDedupe`.

export const S8_WEBHOOK_BASE = '/api/v1/wp/mutation-events'; // Jim S8-D1 canonical (HMAC x-wp-signature, dedup delivery_id)
export const S8_JIT_BASE = '/api/v1/jit/requests/:id/redeem'; // Jim S8-D1 canonical (one-time redemption enforces replay/use-once/expiry/revocation)

const MAX_BODY_BYTES = Number(process.env.WEBHOOK_BODY_LIMIT_BYTES ?? 10_485_760);
const MAX_AGE_MS = Number(process.env.WEBHOOK_MAX_AGE_MIN ?? 10) * 60_000;

export const WEBHOOK_CASES = [
  {
    id: 's8-wh-replay',
    category: 'webhook-replay',
    // Same delivery GUID replayed (intercepted capture). Denied by DB dedupe.
    request: { method: 'POST', path: S8_WEBHOOK_BASE, deliveryId: 'dup-0001' },
    expects: { rejected: true, replayDedupe: true },
  },
  {
    id: 's8-wh-forged',
    category: 'webhook-forged',
    // Valid-looking envelope but signature is NOT under our secret.
    request: { method: 'POST', path: S8_WEBHOOK_BASE, forgedSig: true, deliveryId: 'f-0002' },
    expects: { rejected: true },
  },
  {
    id: 's8-wh-huge',
    category: 'webhook-huge',
    // Payload exceeds WEBHOOK_BODY_LIMIT_BYTES — rejected at the body parser.
    request: { method: 'POST', path: S8_WEBHOOK_BASE, bytes: MAX_BODY_BYTES + 1, deliveryId: 'h-0003' },
    expects: { rejected: true, reason: 'body-limit' },
  },
];

// JIT cases: token is a single-use, short-TTL grant (flip-point: exact shape TBD).
export const JIT_CASES = [
  {
    id: 's8-jit-replay',
    category: 'jit-replay',
    request: { method: 'POST', path: S8_JIT_BASE, token: 'JIT-REPLAY' },
    expects: { rejected: true, singleUse: true },
  },
  {
    id: 's8-jit-token-reuse',
    category: 'jit-token-reuse',
    request: { method: 'POST', path: S8_JIT_BASE, token: 'JIT-REUSE' },
    expects: { rejected: true, singleUse: true },
  },
  {
    id: 's8-jit-expiry',
    category: 'jit-expiry',
    request: { method: 'POST', path: S8_JIT_BASE, token: 'JIT-EXPIRED', expired: true },
    expects: { rejected: true },
  },
  {
    id: 's8-jit-revocation',
    category: 'jit-revocation',
    request: { method: 'POST', path: S8_JIT_BASE, token: 'JIT-REVOKED', revoked: true },
    expects: { rejected: true },
  },
];

export const ABUSE_CASES = [...WEBHOOK_CASES, ...JIT_CASES];

export const LIMITS = { MAX_BODY_BYTES, MAX_AGE_MS };

// S7-D6 prod-control abuse matrix (D6 / oscar). Single source of truth for the
// unit contract check + the live integration battery.
//
// RECONCILED 2026-08-28 against the real @platform/prodctl wrapper (S7-D2, 9557174)
// and Jim's S7-D1 authz/audit. The wrapper surface is executeCommand({ op, target })
// — NOT free-form {command,args}. resolveCommand() rejects:
//   - unknown op (not in PROD_ALLOW_LIST)
//   - target not matching ^[A-Za-z0-9._:-]+$ (flag/space injection)
//   - DENY_PATTERNS: /docker\s+exec/i, /\/bin\/(sh|bash|zsh|csh)/i, /[|;&`$]/, /\.\./, /--/
// All rejections throw ProdCommandRejectedError BEFORE any execFile — i.e. no
// remote change. Jim's route maps this to a 4xx with envelope.ok===false.
//
// Abuse categories (from the GO): arbitrary docker exec, shell invocation,
// malicious arguments, shell metacharacters, path traversal, arg validation.
// Cross-cutting guarantee: a denied action makes NO remote change.
export const PROD_CONTROL_BASE = process.env.PROD_CONTROL_BASE_URL ?? 'http://127.0.0.1:3100';

/**
 * @typedef {Object} AbuseCase
 * @property {string} id
 * @property {'arbitrary-exec'|'shell-invocation'|'malicious-args'|'shell-metachars'|'path-traversal'|'arg-validation'} category
 * @property {string} description
 * @property {{op:string, target:string}} request
 * @property {{rejected:boolean, noSideEffect:boolean}} expects
 */

export const ABUSE_CASES = [
  {
    id: 'pc-arbitrary-docker-exec',
    category: 'arbitrary-exec',
    description: 'Attempt to drive `docker exec` through the restricted wrapper',
    request: { op: 'inventory', target: 'x; docker exec -it platform-dev-postgres-1 sh' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-shell-invocation',
    category: 'shell-invocation',
    description: 'Attempt a raw shell via /bin/sh operand',
    request: { op: 'inventory', target: '/bin/sh -c id' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-malicious-args',
    category: 'malicious-args',
    description: 'Allowed op but destructive flag payload in target',
    request: { op: 'deploy', target: '--rm -rf /' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-shell-metachars',
    category: 'shell-metachars',
    description: 'Shell metacharacters inside target must not break out',
    request: { op: 'deploy', target: 'a; rm -rf /' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-path-traversal',
    category: 'path-traversal',
    description: 'Path traversal in target must be rejected by deny pattern',
    request: { op: 'health', target: '../etc/passwd' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-arg-validation-unknown',
    category: 'arg-validation',
    description: 'Op not present in the allow-list is rejected',
    request: { op: 'rm', target: 'x' },
    expects: { rejected: true, noSideEffect: true },
  },
  {
    id: 'pc-arg-validation-empty',
    category: 'arg-validation',
    description: 'Empty target fails validation',
    request: { op: 'inventory', target: '' },
    expects: { rejected: true, noSideEffect: true },
  },
];

// ---- FLIP-POINTS (reconcile at live GO if Jim's route differs) ----
// 1. Endpoint path: assumed POST /api/v1/prod-control/execute with body {op,target}.
//    Update ABUSE_CASES[].request usage + the integration test path if Jim used another.
// 2. HTTP status: wrapper throws one error type (ProdCommandRejectedError) for all
//    rejections; Jim's route most likely returns 403 FORBIDDEN uniformly. The
//    integration test asserts 400<=status<500 + envelope.ok===false (code-agnostic),
//    so a 422 mapping for target-validation would still pass.
// 3. Auth: live battery sends Authorization: Bearer ${PROD_CONTROL_TOKEN} (bootstrap +
//    step-up flow is Jim S7-D1's surface; set the token at run).
// 4. noSideEffect probe: implemented as active-run-count equality via GET ${BASE}/runs
//    (flip-point if Jim exposes a different status/audit route).

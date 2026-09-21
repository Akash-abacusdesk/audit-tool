# Error conventions

One envelope shape, one closed set of codes. Codes live in `@platform/shared/src/errors.ts`
(`ErrorCode`) — adding one is an API contract change, do it consciously.

## Canonical set

| code              | HTTP | meaning                                                        |
|-------------------|------|----------------------------------------------------------------|
| VALIDATION_ERROR  | 422  | syntactically valid request, semantically invalid body/params   |
| UNAUTHORIZED      | 401  | missing/invalid credentials (Section 2 will own auth flows)     |
| FORBIDDEN         | 403  | authenticated but not allowed                                   |
| NOT_FOUND         | 404  | resource doesn't exist (also for unrouteable paths)             |
| CONFLICT          | 409  | state conflict incl. idempotency-key fingerprint mismatch       |
| RATE_LIMITED      | 429  | too many requests                                               |
| INTERNAL          | 500  | unexpected server error                                         |
| UNAVAILABLE       | 503  | dependency down / shutting down                                 |

## Rules

1. **Throw, don't format.** Routes throw `new ApiError(code, message, details?)`; a single
   Fastify error handler maps `ApiError.status` → HTTP status and wraps everything else as
   `INTERNAL` (logged with stack, response carries no stack/internal detail).
2. **Envelope is mandatory** (see api-conventions.md). `error.requestId` always present.
3. **details is optional and safe-for-client**: field-level zod issues etc. Never echo secrets,
   SQL, stack traces or upstream URLs.
4. Framework errors (malformed JSON, unknown route) are translated to the same envelope —
   clients only ever see this document's shape.
5. Retryability: clients may auto-retry 429/503 (with backoff) and idempotent 5xx;
   everything else needs a changed request.

## Logging

- `INTERNAL` logs at `error` level with stack + requestId; expected failures (4xx) log at `info`.
- Workers follow the same rule set for job failures: catch, classify, rethrow wrapped in
  `ApiError` so queue retry policies can branch on `.status < 500` (no retry) vs ≥500 (retry).

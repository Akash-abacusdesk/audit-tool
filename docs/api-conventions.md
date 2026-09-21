# API conventions

All HTTP APIs in the platform follow these rules. `@platform/shared` exports the
envelope types, error codes and zod contracts — import them, don't re-declare.

## Versioning & paths

- Base path: `/api/v1/…`. Breaking change ⇒ new version prefix; additive fields are non-breaking.
- Resource names: plural kebab-case nouns (`/api/v1/examples`).
- Health (not versioned): `GET /healthz` liveness (process up), `GET /readyz` readiness (deps reachable: DB via pool, pg-boss started).

## Response envelope (mandatory)

```jsonc
// success — always 2xx + ok:true
{ "ok": true, "data": { … } }

// failure — never a 2xx
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "example 123 not found",
                          "requestId": "req-123" } }
```

- Helpers: `ok(data)` / thrown `ApiError` from `@platform/shared`; the Fastify error handler does the wrapping. Route code never hand-builds error bodies.
- See error-conventions.md for the code ↔ status mapping.

## Requests

- Input validation with the zod schemas from `@platform/shared` contracts at the trust boundary; invalid input ⇒ throw `ApiError('VALIDATION_ERROR', …, details)` → 422.
- Pagination (list endpoints): cursor-based — request `?limit=` (default 50, max 200), response `data: { items, nextCursor }`.
- Unsafe methods SHOULD accept `Idempotency-Key` header; semantics in db-conventions.md §3.

## Tracing / correlation

- Honor inbound `x-request-id`; otherwise generate one. Echo it on every response header and inside every error envelope (`error.requestId`). Log lines include it.

## Conventions exercised

The reference implementation of all of the above is `services/api/src/routes/examples.ts`
(POST with validation + idempotency-key, GET with 404 path) — copy its shape for new routes.

/**
 * Canonical error codes ↔ HTTP status mapping. Adding a code is an API contract change.
 * See docs/error-conventions.md.
 */
export declare const ERROR_CODES: {
    readonly VALIDATION_ERROR: 422;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly NOT_FOUND: 404;
    readonly CONFLICT: 409;
    readonly RATE_LIMITED: 429;
    readonly INTERNAL: 500;
    readonly UNAVAILABLE: 503;
};
export type ErrorCode = keyof typeof ERROR_CODES;
export declare class ApiError extends Error {
    readonly code: ErrorCode;
    readonly status: number;
    readonly details?: unknown;
    constructor(code: ErrorCode, message: string, details?: unknown);
    /** True when the caller (not the server) caused the failure — drives retry policies. */
    get isClientError(): boolean;
}
/**
 * Wrap an unknown thrown value into an ApiError.
 * Framework errors (Fastify validation/parsing) carry a truthful 4xx
 * `statusCode` — preserve it via the closest canonical code instead of
 * masking caller mistakes as INTERNAL.
 */
export declare function toApiError(err: unknown): ApiError;

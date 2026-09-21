/**
 * Canonical error codes ↔ HTTP status mapping. Adding a code is an API contract change.
 * See docs/error-conventions.md.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }

  /** True when the caller (not the server) caused the failure — drives retry policies. */
  get isClientError(): boolean {
    return this.status < 500;
  }
}

/**
 * Wrap an unknown thrown value into an ApiError.
 * Framework errors (Fastify validation/parsing) carry a truthful 4xx
 * `statusCode` — preserve it via the closest canonical code instead of
 * masking caller mistakes as INTERNAL.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const entries = Object.entries(ERROR_CODES) as [ErrorCode, number][];
    const code = entries.find(([, s]) => s === status)?.[0] ?? 'VALIDATION_ERROR';
    return new ApiError(code, (err as Error).message || 'request rejected');
  }
  return new ApiError('INTERNAL', 'internal server error');
}

const RETRYABLE = new Set([429, 502, 503, 504, 529]);

/**
 * Wrap a fetch so transient upstream answers (rate limit / overloaded / bad gateway) are retried with jittered
 * backoff, honouring Retry-After (capped). Network errors and aborts are NOT retried: an abort means the caller's
 * own timeout fired, and re-sending would only outlive it. Total time stays bounded by the caller's signal.
 */
export function withRetry(f: typeof fetch, opts: { tries?: number; baseMs?: number; maxWaitMs?: number } = {}): typeof fetch {
  const tries = opts.tries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 5_000;
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const res = await f(input, init);
      if (!RETRYABLE.has(res.status) || attempt >= tries) return res;
      const ra = Number(res.headers.get('retry-after'));
      const wait = Math.min(maxWaitMs, Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseMs * 2 ** (attempt - 1) + Math.random() * baseMs);
      await new Promise((r) => setTimeout(r, wait));
    }
  };
}

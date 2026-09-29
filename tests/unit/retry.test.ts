import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '@platform/shared';

const res = (status: number, headers: Record<string, string> = {}) => new Response('x', { status, headers });

describe('withRetry', () => {
  it('retries transient statuses then returns the good response', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { 'retry-after': '0' })).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const out = await withRetry(f as never, { baseMs: 1 })('http://x');
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last try and returns the failing response', async () => {
    const f = vi.fn().mockResolvedValue(res(503));
    const out = await withRetry(f as never, { tries: 2, baseMs: 1 })('http://x');
    expect(out.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const f = vi.fn().mockResolvedValue(res(404));
    expect((await withRetry(f as never)('http://x')).status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('toApiError', () => {
  it('maps a ZodError from a bare schema.parse() to a 422, not a 500', async () => {
    const { z } = await import('zod');
    const { toApiError } = await import('@platform/shared');
    const err = (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })();
    const api = toApiError(err);
    expect(api.code).toBe('VALIDATION_ERROR');
    expect(api.status).toBe(422);
  });
});

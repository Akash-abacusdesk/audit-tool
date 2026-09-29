import type { ApiResponse } from '@platform/shared';
import { getToken } from './session';

export class ApiRequestError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

/**
 * Every call goes through the same-origin /api-proxy/* rewrite (next.config.ts)
 * to the real API — no CORS, token never leaves this origin.
 */
export async function apiFetch<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown }
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`/api-proxy${path}`, {
    ...init,
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const envelope = (await res.json()) as ApiResponse<T>;
  if (!envelope.ok) {
    throw new ApiRequestError(envelope.error.code, envelope.error.message, res.status);
  }
  return envelope.data;
}

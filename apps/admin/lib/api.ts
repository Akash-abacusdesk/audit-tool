import type { ApiResponse } from '@platform/shared';
import { getToken } from './session';

export class ApiRequestError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

/**
 * The shell registers a function that asks the admin for their password (and authenticator code) and resolves true
 * once the step-up succeeded. apiFetch calls it when the API answers "step-up required", then retries once, so pages
 * never need their own step-up handling.
 */
type StepUpPrompter = () => Promise<boolean>;
let stepUpPrompter: StepUpPrompter | null = null;
export function setStepUpPrompter(fn: StepUpPrompter | null): void {
  stepUpPrompter = fn;
}

/**
 * Every call goes through the same-origin /api-proxy/* rewrite (next.config.ts)
 * to the real API — no CORS, token never leaves this origin.
 */
export async function apiFetch<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown; noStepUp?: boolean }
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
    const details = (envelope.error as { details?: { stepUpRequired?: boolean } }).details;
    if (details?.stepUpRequired && stepUpPrompter && !init?.noStepUp) {
      if (await stepUpPrompter()) return apiFetch<T>(path, { ...init, noStepUp: true });
    }
    throw new ApiRequestError(envelope.error.code, envelope.error.message, res.status, details);
  }
  return envelope.data;
}

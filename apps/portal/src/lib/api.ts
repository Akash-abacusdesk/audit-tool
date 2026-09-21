import type { ApiResponse } from '@platform/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...init });
  } catch {
    throw new ApiRequestError('UNAVAILABLE', 'API unreachable');
  }
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  if (body?.ok) return body.data;
  const err = body && !body.ok ? body.error : undefined;
  throw new ApiRequestError(
    err?.code ?? 'INTERNAL',
    err?.message ?? `request failed with status ${res.status}`,
    err?.requestId
  );
}

'use client';

import type { TelegramAuthorizationDto, TelegramAuthorizationInput } from '@platform/shared';
import { TELEGRAM_OPS } from '@platform/shared';
import { authFetch } from './auth';

const BASE = '/api/v1/telegram/authorizations';

export const TELEGRAM_ACTIONS = TELEGRAM_OPS;

export async function listTelegramAuthorizations(includeRevoked = false): Promise<TelegramAuthorizationDto[]> {
  const q = includeRevoked ? '?include_revoked=true' : '';
  return authFetch<TelegramAuthorizationDto[]>(`${BASE}${q}`);
}

export async function createTelegramAuthorization(
  input: TelegramAuthorizationInput
): Promise<TelegramAuthorizationDto> {
  return authFetch<TelegramAuthorizationDto>(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function revokeTelegramAuthorization(id: string): Promise<{ id: string; revoked: true }> {
  return authFetch<{ id: string; revoked: true }>(`${BASE}/${id}`, { method: 'DELETE' });
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@platform/shared';
import { apiFetch } from './api';
import { clearToken, getToken } from './session';

/** Verifies the stored token against /auth/me; bounces to /login if absent/invalid. */
export function useMe(): { me: MeResponse | null; loading: boolean } {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    apiFetch<MeResponse>('/auth/me')
      .then(setMe)
      .catch(() => {
        clearToken();
        router.replace('/login');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { me, loading };
}

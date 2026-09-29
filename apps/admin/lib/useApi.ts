'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiRequestError } from './api';

/** GET a path on mount (and whenever `path` changes). `null` path = do not fetch. Returns data, error, and a reload. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (path === null) return;
    try {
      setData(await apiFetch<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Could not load this page. Try again.');
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);
  return { data, error, reload: load, setData };
}

/** Human message for a failed action (API message when there is one). */
export const errMsg = (e: unknown, fallback: string): string => (e instanceof ApiRequestError ? e.message : fallback);

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { permissionsFor, type MeResponse, type Permission } from '@platform/shared';
import { apiFetch, ApiRequestError } from './api';

const TOKEN_KEY = 'dso.session.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** apiFetch + Bearer token; a 401 clears the session and returns to login. */
export async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  try {
    return await apiFetch<T>(path, { ...init, headers });
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'UNAUTHORIZED') {
      setToken(null);
      window.location.href = '/login';
    }
    throw err;
  }
}

export async function login(email: string, password: string): Promise<MeResponse> {
  const session = await apiFetch<{ token: string; user: MeResponse['user'] }>('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  setToken(session.token);
  return { user: session.user, bindings: [] };
}

export interface BootstrapResult {
  token: string;
  expiresAt: string;
}

export async function bootstrap(input: {
  email: string;
  password: string;
  displayName: string;
  orgName: string;
  orgSlug: string;
}): Promise<BootstrapResult> {
  const session = await apiFetch<BootstrapResult>('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  setToken(session.token);
  return session;
}

export async function logout(): Promise<void> {
  try {
    await authFetch('/api/v1/auth/logout', { method: 'POST' });
  } catch {
    // best-effort — the local session dies regardless
  }
  setToken(null);
}

interface SessionCtx {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionCtx>({
  me: null,
  loading: true,
  error: null,
  refresh: async () => {},
});

export function useSession(): SessionCtx {
  return useContext(SessionContext);
}

/** Whether ANY of the actor's bindings grant `perm` at their scope (nav/page gating). */
export function canAnywhere(me: MeResponse | null, perm: Permission): boolean {
  if (!me) return false;
  const orgs = new Set(me.bindings.map((b) => b.orgId));
  for (const orgId of orgs) {
    if (permissionsFor(me.bindings, { orgId }).has(perm)) return true;
  }
  return false;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const data = await authFetch<MeResponse>('/api/v1/auth/me');
      setMe(data);
      setError(null);
    } catch (err) {
      // 401 already redirected inside authFetch; surface anything else as degraded shell.
      setMe(null);
      setError(err instanceof ApiRequestError ? `${err.code}: ${err.message}` : 'session check failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ me, loading, error, refresh }), [me, loading, error, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

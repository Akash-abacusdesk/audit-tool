const TOKEN_KEY = 'admin.session.token';

// Client-side only (this is an internal admin tool, not a public app — a
// plain localStorage token is an acceptable tradeoff over building out
// httpOnly-cookie session plumbing the API doesn't support anyway).
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

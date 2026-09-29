const TOKEN_KEY = 'admin.session.token';

// Client-side only. sessionStorage, not localStorage: the token dies with the tab instead of sitting on disk
// until it expires, which shrinks what an XSS (or a shared machine) can take. An httpOnly cookie would be
// stronger but needs cookie-session plumbing the API doesn't have (see the CSP in next.config.ts for the XSS side).
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

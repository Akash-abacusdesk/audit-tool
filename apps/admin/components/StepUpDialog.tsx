'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiRequestError, setStepUpPrompter } from '../lib/api';

/**
 * Privileged actions (sites, team, production) need a fresh step-up. This dialog is what apiFetch opens when the API
 * asks for one: password, plus the authenticator code if the admin has enrolled one. Mounted once in the app shell.
 */
export default function StepUpDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ password: '', code: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const prompt = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        // A second concurrent request joins the dialog that is already open instead of stacking another.
        const prev = settle.current;
        settle.current = (ok) => {
          prev?.(ok);
          resolve(ok);
        };
        setError(null);
        setOpen(true);
      }),
    []
  );

  useEffect(() => {
    setStepUpPrompter(prompt);
    return () => setStepUpPrompter(null);
  }, [prompt]);

  function close(ok: boolean) {
    setOpen(false);
    setForm({ password: '', code: '' });
    settle.current?.(ok);
    settle.current = null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { password: form.password };
      if (form.code) body.code = form.code.trim();
      await apiFetch('/auth/step-up', { method: 'POST', body, noStepUp: true });
      close(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'step-up failed');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
      <form onSubmit={submit} className="surface-solid w-full max-w-sm p-6">
        <h2 id="stepup-title" className="text-base font-semibold">Confirm it&apos;s you</h2>
        <p className="mb-4 mt-1 text-xs text-[var(--color-text-dim)]">
          This action changes who can access what. Re-enter your password to continue; it stays unlocked for a few minutes.
        </p>
        {error && <p className="mb-3 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]">{error}</p>}
        <label className="label mb-1.5 block">Password</label>
        <input className="input mb-3.5" type="password" autoFocus autoComplete="current-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
        <label className="label mb-1.5 block">Authenticator code (if enabled)</label>
        <input className="input mb-5" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={() => close(false)}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
        </div>
      </form>
    </div>
  );
}

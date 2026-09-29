'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiRequestError, setStepUpPrompter } from '../lib/api';
import { Button, Dialog, Field, Input } from './ui';

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
      setError(err instanceof ApiRequestError ? err.message : 'Step-up failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => close(false)} title="Confirm it is you" description="This action changes who can access what. Re-enter your password to continue; it stays unlocked for a few minutes.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Password" htmlFor="stepup-password" error={error}>
          <Input id="stepup-password" type="password" autoFocus autoComplete="current-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required />
        </Field>
        <Field label="Authenticator code" htmlFor="stepup-code" hint="Only if you have turned on an authenticator app.">
          <Input id="stepup-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="font-mono tracking-[0.3em]" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

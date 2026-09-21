'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiRequestError } from '@/lib/api';
import { bootstrap, login } from '@/lib/auth';

type Mode = 'signin' | 'bootstrap';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      if (mode === 'signin') {
        await login(String(f.get('email')), String(f.get('password')));
      } else {
        await bootstrap({
          email: String(f.get('email')),
          password: String(f.get('password')),
          displayName: String(f.get('displayName')),
          orgName: String(f.get('orgName')),
          orgSlug: String(f.get('orgSlug')),
        });
      }
      // Full navigation so the shell's SessionProvider re-reads the token.
      window.location.href = '/';
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(
          err.code === 'CONFLICT'
            ? 'Setup is already complete — users exist. Sign in instead.'
            : err.message
        );
      } else {
        setError('Something went wrong. Try again.');
      }
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-inset ring-primary/25"
          >
            <span className="size-3 rounded-[5px] bg-primary" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight">DevSecOps Platform</h1>
          <p className="text-xs text-muted-foreground">
            {mode === 'signin'
              ? 'Sign in to the control plane.'
              : 'One-time setup: create the first account and organization.'}
          </p>
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-xs">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Email</span>
            <Input name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Password
              {mode === 'bootstrap' ? (
                <span className="ml-1 font-normal text-muted-foreground/70">(min 12 characters)</span>
              ) : null}
            </span>
            <Input
              name="password"
              type="password"
              required
              minLength={mode === 'bootstrap' ? 12 : 1}
              autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'}
            />
          </label>
          {mode === 'bootstrap' ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Your display name</span>
                <Input name="displayName" required maxLength={100} placeholder="Ada Lovelace" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Org name</span>
                  <Input name="orgName" required maxLength={100} placeholder="Acme Corp" />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Org slug</span>
                  <Input
                    name="orgSlug"
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    title="lowercase letters/digits separated by single dashes"
                    placeholder="acme"
                  />
                </label>
              </div>
            </>
          ) : null}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create first account'}
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          {mode === 'signin' ? 'First run with an empty database? ' : 'Already set up? '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'bootstrap' : 'signin');
              setError(null);
            }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {mode === 'signin' ? 'Run one-time setup' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  );
}

// ponytail: bootstrap-vs-login probed by trying it (409 CONFLICT = already done);
// a GET /auth/status probe would be nicer once jim ships one.

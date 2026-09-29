'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as motion from 'motion/react-m';
import type { SessionDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../lib/api';
import { setToken } from '../../lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = await apiFetch<SessionDto>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken(session.token);
      router.push('/findings');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-[var(--color-accent)]/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 right-0 h-[400px] w-[500px] rounded-full bg-[var(--color-accent-2)]/15 blur-[120px]" />

      <motion.form
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        onSubmit={onSubmit}
        className="surface relative w-full max-w-sm p-8"
      >
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-2)] text-lg font-bold text-white shadow-[0_4px_16px_-2px_rgba(109,139,255,0.5)]">
          D
        </div>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Welcome back</h1>
        <p className="mb-7 text-sm text-[var(--color-text-dim)]">Sign in to the control plane.</p>

        <label className="label mb-1.5 block">Email</label>
        <input
          className="input mb-4"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <label className="label mb-1.5 block">Password</label>
        <input
          className="input mb-6"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 rounded-lg bg-[var(--color-critical)]/10 px-3 py-2 text-sm text-[var(--color-critical)]"
          >
            {error}
          </motion.p>
        )}

        <motion.button
          whileTap={{ scale: 0.98 }}
          type="submit"
          className="btn-primary w-full"
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </motion.button>
      </motion.form>
    </div>
  );
}

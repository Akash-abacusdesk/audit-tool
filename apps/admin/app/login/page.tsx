'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as motion from 'motion/react-m';
import { ArrowRight } from '@phosphor-icons/react';
import type { SessionDto } from '@platform/shared';
import { apiFetch, ApiRequestError } from '../../lib/api';
import { setToken } from '../../lib/session';
import { Button, Field, Input, Panel, ease } from '../../components/ui';

const POINTS = [
  { title: 'One owner per site', body: 'Every site has a named person who runs it and hears first when something breaks.' },
  { title: 'Alerts that arrive', body: 'A failed scan reaches that person and the admins on Telegram, and becomes a task for them.' },
  { title: 'Access with an expiry', body: 'Administrator access to a live site is requested, approved, and gone again in minutes.' },
];

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
      const session = await apiFetch<SessionDto>('/auth/login', { method: 'POST', body: { email, password } });
      setToken(session.token);
      // The admin plane needs a fresh step-up; the password was just typed, so use it now rather than asking again.
      // Best effort: an authenticator code or another network simply falls back to the prompt when it is needed.
      await apiFetch('/auth/step-up', { method: 'POST', body: { password }, noStepUp: true }).catch(() => {});
      router.push('/overview');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Sign-in failed. Check your connection and try again.');
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-14">
        {/* Two slow drifting light pools: transform-only motion, no blur filters on scrolling content. */}
        <motion.div aria-hidden animate={{ x: [0, 40, -10, 0], y: [0, 24, 50, 0] }} transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }} className="pointer-events-none absolute -left-24 top-1/3 size-[30rem] rounded-full bg-accent/[0.09] blur-3xl" />
        <motion.div aria-hidden animate={{ x: [0, -30, 20, 0], y: [0, -30, 10, 0] }} transition={{ duration: 32, repeat: Infinity, ease: 'easeInOut' }} className="pointer-events-none absolute -bottom-32 right-0 size-[26rem] rounded-full bg-low/[0.07] blur-3xl" />

        <div className="relative flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-line-strong">
            <span className="flex size-4 items-center justify-center rounded-[5px] bg-raised ring-1 ring-inset ring-line-strong">
              <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_oklch(0.8_0.15_162/0.9)]" />
            </span>
          </span>
          <span className="text-[13px] font-semibold tracking-tight">DevSecOps</span>
        </div>

        <div className="relative max-w-xl">
          <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease }} className="text-balance text-5xl font-semibold leading-[1.05] tracking-tighter">
            Every site you run has someone watching it.
          </motion.h1>
          <motion.ul initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.12, delayChildren: 0.35 } } }} className="mt-12 flex flex-col gap-6">
            {POINTS.map((p) => (
              <motion.li key={p.title} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease } } }} className="border-t border-line pt-4">
                <div className="text-sm font-medium">{p.title}</div>
                <div className="mt-1 max-w-[46ch] text-sm leading-6 text-ink-dim">{p.body}</div>
              </motion.li>
            ))}
          </motion.ul>
        </div>

        <p className="relative text-xs text-ink-faint">Sign-in is limited after repeated failures, and privileged actions ask you to confirm again.</p>
      </section>

      <section className="flex items-center justify-center px-5 py-12">
        <motion.div initial={{ opacity: 0, y: 18, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6, ease }} className="w-full max-w-[24rem]">
          <Panel>
            <form onSubmit={onSubmit} className="flex flex-col gap-5 p-1">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
                <p className="mt-1 text-sm text-ink-dim">Use the account your admin gave you.</p>
              </div>
              <Field label="Email" htmlFor="email">
                <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password" htmlFor="password" error={error}>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" loading={loading} icon={!loading ? undefined : undefined} className="mt-1 h-11 w-full">
                Continue
                {!loading && <ArrowRight size={16} />}
              </Button>
            </form>
          </Panel>
        </motion.div>
      </section>
    </div>
  );
}

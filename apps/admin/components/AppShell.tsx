'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import type { MeResponse } from '@platform/shared';
import { apiFetch } from '../lib/api';
import { clearToken } from '../lib/session';
import StepUpDialog from './StepUpDialog';

const NAV = [
  { href: '/sites', label: 'Sites' },
  { href: '/team', label: 'Team' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/findings', label: 'Findings' },
  { href: '/scans', label: 'Scans' },
  { href: '/jit', label: 'JIT Access' },
  { href: '/telegram', label: 'Telegram Alerts' },
  { href: '/security', label: 'Security' },
];

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}

export function AppShell({ me, children }: { me: MeResponse; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // best-effort — clear locally regardless
    }
    clearToken();
    router.replace('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="m-4 flex w-60 shrink-0 flex-col">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-2)] text-sm font-bold text-white shadow-[0_4px_12px_-2px_rgba(109,139,255,0.5)]">
            D
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">DevSecOps</div>
            <div className="text-[11px] text-[var(--color-text-faint)] leading-tight">Control Plane</div>
          </div>
        </div>

        <nav className="surface flex flex-col gap-1 p-2">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className="relative">
                {active && (
                  <motion.div
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-xl bg-gradient-to-r from-[var(--color-accent)] to-[#5a72e0] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset]"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <span className={active ? 'sidebar-link-active' : 'sidebar-link'}>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="surface mt-auto flex items-center gap-2.5 p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-2)] text-xs font-semibold text-[var(--color-text-dim)] ring-1 ring-[var(--color-border)]">
            {initials(me.user.email)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{me.user.email}</div>
            <div className="truncate text-[11px] text-[var(--color-text-faint)]">
              {me.bindings.map((b) => b.role).join(', ')}
            </div>
          </div>
          <button onClick={logout} className="btn-ghost !px-2 !py-1.5 text-xs" aria-label="Sign out">
            ⏻
          </button>
        </div>
      </aside>

      <main className="flex-1 p-6 pl-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>
      <StepUpDialog />
    </div>
  );
}

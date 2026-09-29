'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { Command, List, MagnifyingGlass, SignOut, X } from '@phosphor-icons/react';
import type { MeResponse } from '@platform/shared';
import { apiFetch } from '../lib/api';
import { clearToken } from '../lib/session';
import { cn } from '../lib/cn';
import { NAV_GROUPS, NAV_ITEMS } from '../lib/nav';
import { OverviewProvider, useOverview } from '../lib/OverviewContext';
import { Avatar } from './ui';
import { spring } from './ui/motion';
import { CommandPalette } from './CommandPalette';
import StepUpDialog from './StepUpDialog';

const ROLE_LABEL: Record<string, string> = { manager: 'Admin', security_admin: 'Security admin', team_lead: 'Team lead', developer: 'Developer', project_coordinator: 'Coordinator' };

function Brand() {
  return (
    <div className="flex items-center gap-3 px-2">
      {/* Mark composed from primitives: a tray, a core and a signal dot. */}
      <span className="flex size-8 items-center justify-center rounded-[10px] bg-white/[0.05] ring-1 ring-inset ring-line-strong">
        <span className="flex size-4 items-center justify-center rounded-[5px] bg-raised ring-1 ring-inset ring-line-strong">
          <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_oklch(0.8_0.15_162/0.9)]" />
        </span>
      </span>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold tracking-tight">DevSecOps</div>
        <div className="text-[11px] text-ink-faint">Operations console</div>
      </div>
    </div>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data } = useOverview();
  const counters: Record<string, number> = {
    failing: data?.sites.failing ?? 0,
    tasks: (data?.tasks.pending ?? 0) + (data?.tasks.failed ?? 0),
    access: data?.access.pendingRequests ?? 0,
  };

  return (
    <nav className="flex flex-col gap-6" aria-label="Main">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="mb-1.5 px-3 text-xs font-medium text-ink-faint">{group.label}</div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const count = item.badge ? counters[item.badge] : 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex h-9 items-center gap-3 rounded-[10px] px-3 text-[13px] font-medium outline-none transition-colors duration-200 ease-spring',
                      'focus-visible:ring-2 focus-visible:ring-accent/70',
                      active ? 'text-ink' : 'text-ink-dim hover:text-ink'
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        transition={spring}
                        className="absolute inset-0 rounded-[10px] bg-white/[0.07] shadow-hi ring-1 ring-inset ring-line-strong"
                      />
                    )}
                    <item.icon size={18} className={cn('relative transition-colors', active ? 'text-accent' : 'text-ink-faint group-hover:text-ink-dim')} />
                    <span className="relative flex-1">{item.label}</span>
                    {count > 0 && (
                      <span className={cn('relative rounded-md px-1.5 text-[11px] font-medium tabular-nums', item.badge === 'failing' ? 'bg-critical/15 text-critical' : 'bg-white/[0.08] text-ink-dim')}>
                        {count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserCard({ me, onSignOut }: { me: MeResponse; onSignOut: () => void }) {
  const roles = [...new Set(me.bindings.map((b) => ROLE_LABEL[b.role] ?? b.role))];
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-line">
      <Avatar name={me.user.displayName || me.user.email} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px] font-medium">{me.user.displayName || me.user.email}</div>
        <div className="truncate text-[11px] text-ink-faint">{roles.join(', ') || 'No role'}</div>
      </div>
      <button onClick={onSignOut} aria-label="Sign out" className="flex size-8 items-center justify-center rounded-lg text-ink-faint outline-none transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70">
        <SignOut size={18} />
      </button>
    </div>
  );
}

export function AppShell({ me, children }: { me: MeResponse; children: React.ReactNode }) {
  return (
    <OverviewProvider>
      <Shell me={me}>{children}</Shell>
    </OverviewProvider>
  );
}

function Shell({ me, children }: { me: MeResponse; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // best effort: the token is cleared locally regardless
    }
    clearToken();
    router.replace('/login');
  }, [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setDrawer(false), [pathname]);

  const section = NAV_ITEMS.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))?.label ?? '';

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-line px-3 py-5 lg:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
        <UserCard me={me} onSignOut={signOut} />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-canvas/75 px-4 backdrop-blur-xl lg:px-10">
          <button onClick={() => setDrawer(true)} aria-label="Open menu" className="flex size-9 items-center justify-center rounded-lg text-ink-dim hover:bg-white/[0.06] lg:hidden">
            <List size={20} />
          </button>
          <span className="text-[13px] font-medium text-ink-dim">{section}</span>
          <span className="flex-1" />
          <button
            onClick={() => setPalette(true)}
            className="flex h-9 items-center gap-2 rounded-[10px] bg-white/[0.04] px-3 text-[13px] text-ink-faint outline-none ring-1 ring-inset ring-line transition-colors hover:bg-white/[0.07] hover:text-ink-dim focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <MagnifyingGlass size={16} />
            <span className="hidden sm:inline">Jump to</span>
            <kbd className="hidden items-center gap-0.5 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-ink-dim sm:flex">
              <Command size={11} />K
            </kbd>
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1180px] px-4 py-8 lg:px-10 lg:py-10">
          <motion.div key={pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
            {children}
          </motion.div>
        </main>
      </div>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setDrawer(false)} />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={spring}
              className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col gap-8 border-r border-line bg-canvas px-3 py-5 lg:hidden"
            >
              <div className="flex items-center justify-between">
                <Brand />
                <button onClick={() => setDrawer(false)} aria-label="Close menu" className="flex size-9 items-center justify-center rounded-lg text-ink-dim hover:bg-white/[0.06]">
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <SidebarNav onNavigate={() => setDrawer(false)} />
              </div>
              <UserCard me={me} onSignOut={signOut} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <CommandPalette open={palette} onClose={() => setPalette(false)} onSignOut={signOut} />
      <StepUpDialog />
    </div>
  );
}

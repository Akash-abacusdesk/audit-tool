'use client';

import { useMe } from '../../lib/useMe';
import { MeContext } from '../../lib/MeContext';
import { AppShell } from '../../components/AppShell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useMe();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]" />
      </div>
    );
  }
  if (!me) return null; // useMe() already redirected to /login

  return (
    <MeContext.Provider value={me}>
      <AppShell me={me}>{children}</AppShell>
    </MeContext.Provider>
  );
}

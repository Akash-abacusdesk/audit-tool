'use client';

import * as motion from 'motion/react-m';
import { useMe } from '../../lib/useMe';
import { MeContext } from '../../lib/MeContext';
import { AppShell } from '../../components/AppShell';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useMe();

  if (loading) {
    return (
      <div role="status" aria-label="Loading" className="flex min-h-dvh items-center justify-center">
        <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }} className="block size-7 rounded-full border-2 border-line-strong border-t-accent" />
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

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/shell/sidebar';
import { SessionProvider, useSession, getToken } from '@/lib/auth';

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, me, error } = useSession();
  const router = useRouter();
  const anon = !loading && me === null && getToken() === null;

  useEffect(() => {
    if (anon) router.replace('/login');
  }, [anon, router]);

  if (anon) return null;
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span aria-hidden className="size-8 animate-pulse rounded-lg bg-primary/20" />
      </div>
    );
  }
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <p className="border-b border-destructive/30 bg-destructive/5 px-6 py-1.5 text-xs text-destructive">
            Session unavailable — {error}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}

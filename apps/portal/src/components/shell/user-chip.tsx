'use client';

import { useRouter } from 'next/navigation';
import { useSession, logout } from '@/lib/auth';

export function UserChip() {
  const { me } = useSession();
  const router = useRouter();
  if (!me) return null;
  return (
    <div className="flex items-center gap-3">
      <span
        title={me.user.email}
        className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary ring-1 ring-inset ring-primary/25"
      >
        {me.user.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="hidden text-xs font-medium sm:inline">{me.user.displayName}</span>
      <button
        type="button"
        onClick={async () => {
          await logout();
          router.replace('/login');
        }}
        className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground"
      >
        Sign out
      </button>
    </div>
  );
}

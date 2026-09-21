'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_GROUPS = [
  {
    label: null,
    items: [
      { href: '/', label: 'Overview' },
      { href: '/design', label: 'Design System' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { href: '/onboarding', label: 'Project onboarding' },
      { href: '/git', label: 'Git & stacks' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/access', label: 'Access' },
      { href: '/audit', label: 'Audit Log' },
      { href: '/settings', label: 'Settings' },
    ],
  },
  {
    label: 'Security',
    items: [
      { href: '/findings', label: 'Findings' },
      { href: '/vulnerabilities', label: 'Vulnerabilities' },
    ],
  },
  {
    label: 'Reserved',
    items: [
      { label: 'Tasks', reservedFor: 'Section 3' },
      { label: 'Updates', reservedFor: 'Section 4' },
    ],
  },
] as const;

function BrandMark() {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-inset ring-primary/25"
    >
      <span className="size-2 rounded-[4px] bg-primary" />
    </span>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <BrandMark />
        <Link href="/" className="text-sm font-semibold tracking-tight">
          DevSecOps Platform
        </Link>
      </div>
      <nav aria-label="Primary" className="flex flex-1 flex-col gap-5 overflow-y-auto p-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} className="space-y-1">
            {group.label ? (
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) =>
              'href' in item ? (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname === item.href ? 'page' : undefined}
                  className={`flex h-8 items-center rounded-lg px-2.5 text-[13px] transition-colors duration-150 ease-out ${
                    pathname === item.href
                      ? 'bg-primary/12 font-medium text-primary ring-1 ring-inset ring-primary/20'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  key={item.label}
                  title={`Reserved — lands in ${item.reservedFor}`}
                  aria-disabled
                  className="flex h-8 cursor-not-allowed items-center rounded-lg px-2.5 text-[13px] text-muted-foreground/60"
                >
                  {item.label}
                </span>
              )
            )}
          </div>
        ))}
      </nav>
      <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">Section 1 shell</div>
    </aside>
  );
}


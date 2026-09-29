import { cn } from '../../lib/cn';

const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

/** Squircle, not circle: reads as a person tile rather than the default round avatar. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-[10px] bg-white/[0.07] font-medium text-ink-dim ring-1 ring-inset ring-line-strong',
        size === 'sm' ? 'size-7 text-[11px]' : 'size-9 text-xs',
        className
      )}
    >
      {initials(name)}
    </span>
  );
}

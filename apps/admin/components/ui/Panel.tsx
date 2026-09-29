import { cn } from '../../lib/cn';

/**
 * The console's one container: an outer tray (hairline ring, 6px inset) holding an inner core with its own top
 * highlight. Concentric radii (16px tray, 10px core) keep the curves parallel. Use `flush` for lists and tables.
 */
export function Panel({
  children,
  className,
  coreClassName,
  flush,
}: {
  children: React.ReactNode;
  className?: string;
  coreClassName?: string;
  flush?: boolean;
}) {
  return (
    <div className={cn('rounded-2xl bg-white/[0.03] p-1.5 ring-1 ring-line', className)}>
      <div className={cn('rounded-[10px] bg-raised shadow-hi', flush ? 'overflow-hidden' : 'p-5', coreClassName)}>{children}</div>
    </div>
  );
}

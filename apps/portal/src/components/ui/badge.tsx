import type { Severity } from '@/lib/severity';

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'bg-severity-critical/10 text-severity-critical ring-severity-critical/25',
  high: 'bg-severity-high/10 text-severity-high ring-severity-high/25',
  medium: 'bg-severity-medium/10 text-severity-medium ring-severity-medium/25',
  low: 'bg-severity-low/10 text-severity-low ring-severity-low/25',
  info: 'bg-severity-info/10 text-severity-info ring-severity-info/25',
};

export function Badge({
  className = '',
  dot = false,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { dot?: boolean }) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium ring-1 ring-inset ${className}`}
      {...props}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {props.children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge className={SEVERITY_CLASS[severity]} dot data-severity={severity}>
      {severity}
    </Badge>
  );
}

export function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <Badge
      dot
      className={
        ok
          ? 'bg-success/10 text-success ring-success/25'
          : 'bg-destructive/10 text-destructive ring-destructive/25'
      }
    >
      {label ?? (ok ? 'ready' : 'down')}
    </Badge>
  );
}

import type { Severity } from '@/lib/severity';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card/50 px-8 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function ErrorState({
  code,
  message,
  requestId,
}: {
  code: string;
  message: string;
  requestId?: string;
}) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4" role="alert">
      <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <span aria-hidden className="inline-block size-2 rounded-full bg-destructive" />
        {code}
      </p>
      <p className="mt-1.5 text-sm">{message}</p>
      {requestId ? (
        <p className="mt-2 font-mono text-xs text-muted-foreground">requestId: {requestId}</p>
      ) : null}
    </div>
  );
}

export function AccessDenied({ permission }: { permission: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8" role="alert">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className="inline-block size-2 rounded-full bg-destructive" />
        Access denied
      </p>
      <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
        Your role does not include <code className="font-mono text-xs">{permission}</code> at any
        scope you belong to. Ask a security admin or manager if you need access.
      </p>
    </div>
  );
}

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

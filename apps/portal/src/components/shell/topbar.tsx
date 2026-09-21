import { UserChip } from '@/components/shell/user-chip';

const ENV = process.env.NEXT_PUBLIC_ENV ?? 'dev';

export function Topbar({ trail }: { trail?: string[] }) {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface/80 px-6 backdrop-blur-sm">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
        <span className="text-muted-foreground">Platform</span>
        {(trail ?? []).map((crumb) => (
          <span key={crumb} className="flex items-center gap-1.5">
            <span aria-hidden className="text-muted-foreground/50">/</span>
            <span className="font-medium">{crumb}</span>
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${ENV === 'prod' ? 'bg-success' : 'bg-primary'}`}
          />
          <span className="font-medium uppercase tracking-wide">{ENV}</span>
        </div>
        <UserChip />
      </div>
    </header>
  );
}

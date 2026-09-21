import { Input } from './input';

export function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input {...props} />
    </label>
  );
}

export function Select({ label, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  if (!label) return <select className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs transition-colors duration-150 outline-none hover:border-muted-foreground/40 focus-visible:border-primary" {...props} />;
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs transition-colors duration-150 outline-none hover:border-muted-foreground/40 focus-visible:border-primary"
        {...props}
      />
    </label>
  );
}

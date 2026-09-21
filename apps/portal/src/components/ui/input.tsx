export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground shadow-xs transition-colors duration-150 outline-none placeholder:text-muted-foreground hover:border-muted-foreground/40 focus-visible:border-primary aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 ${className}`}
      {...props}
    />
  );
}

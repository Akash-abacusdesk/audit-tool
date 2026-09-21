const VARIANTS = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 shadow-xs',
  outline: 'border border-border bg-card text-foreground hover:bg-muted active:bg-muted/70',
  destructive:
    'bg-destructive text-white hover:bg-destructive/90 active:bg-destructive/80 shadow-xs',
  ghost: 'bg-transparent text-foreground hover:bg-muted active:bg-muted/70',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-[background-color,box-shadow] duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

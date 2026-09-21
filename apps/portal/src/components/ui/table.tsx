export function Table({ className = '', ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-xs">
      <table className={`w-full border-collapse text-sm ${className}`} {...props} />
    </div>
  );
}

export function Th({ className = '', ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`border-b border-border px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${className}`}
      {...props}
    />
  );
}

export function Td({ className = '', ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={`border-b border-border/60 px-3.5 py-2.5 tabular-nums transition-colors duration-150 ${className}`}
      {...props}
    />
  );
}

export function Tr({ className = '', ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={`transition-colors duration-150 hover:bg-muted/50 ${className}`} {...props} />;
}

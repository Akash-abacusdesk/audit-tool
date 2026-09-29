'use client';

import { CaretUpDown } from '@phosphor-icons/react';
import { cn } from '../../lib/cn';

export const controlClass =
  'h-10 w-full rounded-[10px] bg-sunken px-3 text-sm text-ink outline-none ring-1 ring-inset ring-line-strong transition duration-200 ' +
  'ease-spring placeholder:text-ink-faint hover:ring-white/25 focus:ring-2 focus:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50';

/** Label above, control, then hint or error below (the label is never the placeholder). */
export function Field({ label, htmlFor, hint, error, children, className }: { label: string; htmlFor?: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-dim">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-critical">{error}</p> : hint ? <p className="text-xs leading-5 text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(controlClass, 'cursor-pointer appearance-none pr-9', className)} {...rest}>
        {children}
      </select>
      <CaretUpDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint" />
    </div>
  );
}

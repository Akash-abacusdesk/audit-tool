'use client';

import { useId } from 'react';
import * as motion from 'motion/react-m';
import { cn } from '../../lib/cn';
import { spring } from './motion';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  count?: number;
  /** tailwind text colour class for a leading dot */
  dot?: string;
}

/** A filter switch. The selected background slides between options (shared layout animation) instead of jumping. */
export function Segmented<V extends string>({ options, value, onChange, label }: { options: SegmentOption<V>[]; value: V; onChange: (v: V) => void; label: string }) {
  const id = useId();
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-xl bg-sunken p-1 ring-1 ring-inset ring-line">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-medium capitalize outline-none transition-colors duration-200',
              'focus-visible:ring-2 focus-visible:ring-accent/70',
              active ? 'text-ink' : 'text-ink-dim hover:text-ink'
            )}
          >
            {active && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-lg bg-raised shadow-hi ring-1 ring-inset ring-line-strong" />}
            {o.dot && <span className={cn('relative size-1.5 rounded-full bg-current', o.dot)} />}
            <span className="relative">{o.label}</span>
            {o.count !== undefined && <span className="relative text-[11px] tabular-nums text-ink-faint">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

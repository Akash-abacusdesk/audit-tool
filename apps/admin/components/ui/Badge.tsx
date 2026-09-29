import { cn } from '../../lib/cn';

export type Tone = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'neutral' | 'accent';

const TONE: Record<Tone, string> = {
  critical: 'bg-critical/10 text-critical ring-critical/25',
  high: 'bg-high/10 text-high ring-high/25',
  medium: 'bg-medium/10 text-medium ring-medium/25',
  low: 'bg-low/10 text-low ring-low/25',
  info: 'bg-info/10 text-info ring-info/25',
  neutral: 'bg-white/[0.05] text-ink-dim ring-line-strong',
  accent: 'bg-accent/10 text-accent ring-accent/25',
};
const DOT: Record<Tone, string> = {
  critical: 'bg-critical', high: 'bg-high', medium: 'bg-medium', low: 'bg-low', info: 'bg-info', neutral: 'bg-ink-faint', accent: 'bg-accent',
};

/** A 6px-radius chip (the chip tier of the shape rule); the dot carries the status colour for scanning down a list. */
export function Badge({ tone = 'neutral', dot, children, className }: { tone?: Tone; dot?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONE[tone], className)}>
      {dot && <span className={cn('size-1.5 rounded-full', DOT[tone])} />}
      {children}
    </span>
  );
}

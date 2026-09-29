'use client';

import * as motion from 'motion/react-m';
import type { HTMLMotionProps } from 'motion/react';
import { CircleNotch } from '@phosphor-icons/react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent shadow-accent hover:bg-accent-strong',
  secondary: 'bg-white/[0.06] text-ink shadow-hi ring-1 ring-inset ring-line-strong hover:bg-white/[0.1]',
  ghost: 'text-ink-dim hover:bg-white/[0.06] hover:text-ink',
  danger: 'bg-critical/10 text-critical ring-1 ring-inset ring-critical/25 hover:bg-critical/20',
};
const SIZE: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-10 gap-2 px-4 text-sm',
};

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/** A physical press (scale on tap) plus a colour shift on hover. Controls are 10px-radius by the shape rule. */
export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <motion.button
      whileTap={disabled || loading ? undefined : { scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[10px] font-medium outline-none',
        'transition-colors duration-200 ease-spring focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? (
        <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }} className="flex">
          <CircleNotch size={16} />
        </motion.span>
      ) : (
        icon
      )}
      {children}
    </motion.button>
  );
}

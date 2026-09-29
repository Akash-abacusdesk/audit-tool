'use client';

import * as motion from 'motion/react-m';
import { ease } from './motion';

/** Says what is missing and how to fill it, instead of leaving a blank panel. */
export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      className="flex flex-col items-center px-6 py-14 text-center"
    >
      <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-white/[0.05] text-ink-dim ring-1 ring-inset ring-line-strong">{icon}</span>
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-[42ch] text-pretty text-sm leading-6 text-ink-faint">{children}</p>}
    </motion.div>
  );
}

'use client';

import * as motion from 'motion/react-m';
import { rise, stagger } from './motion';

/** A group whose `RevealItem` children fade up one after another when it mounts. */
export function RevealGroup({ children, className, gap }: { children: React.ReactNode; className?: string; gap?: number }) {
  return (
    <motion.div variants={stagger(gap)} initial="hidden" animate="show" className={className}>
      {children}
    </motion.div>
  );
}

export function RevealItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div variants={rise} className={className}>
      {children}
    </motion.div>
  );
}

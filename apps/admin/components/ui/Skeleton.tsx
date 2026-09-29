'use client';

import * as motion from 'motion/react-m';
import { cn } from '../../lib/cn';

/** Placeholder block: a slow opacity breath, so loading states keep the shape of the content that replaces them. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <motion.div
      aria-hidden
      animate={{ opacity: [0.45, 0.9, 0.45] }}
      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      className={cn('rounded-md bg-white/[0.07]', className)}
    />
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

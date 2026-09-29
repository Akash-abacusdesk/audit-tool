'use client';

import { useEffect } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { spring } from './motion';

/** Modal with a dimmed backdrop; Escape or a click outside closes it. Reserve for interruptions (step-up, commands). */
export function Dialog({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[14vh] backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={spring}
            className="w-full max-w-md rounded-2xl bg-white/[0.04] p-1.5 shadow-float ring-1 ring-line-strong"
          >
            <div className="rounded-[10px] bg-raised p-6 shadow-hi">
              <h2 className="text-base font-semibold tracking-tight">{title}</h2>
              {description && <p className="mt-1 text-sm leading-6 text-ink-dim">{description}</p>}
              <div className="mt-5">{children}</div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

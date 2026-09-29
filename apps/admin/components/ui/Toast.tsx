'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import { spring } from './motion';

interface Toast {
  id: number;
  tone: 'success' | 'error';
  message: string;
}
const ToastContext = createContext<{ success: (m: string) => void; error: (m: string) => void } | null>(null);

export function useToast() {
  const c = useContext(ToastContext);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}

/** Transient confirmations and failures. Inline messages stay for form validation; toasts are for outcomes. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4500);
    },
    [dismiss]
  );
  const api = useMemo(() => ({ success: (m: string) => push('success', m), error: (m: string) => push('error', m) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
              transition={spring}
              className="pointer-events-auto flex items-start gap-3 rounded-xl bg-raised p-3.5 shadow-float ring-1 ring-line-strong"
            >
              <span className={t.tone === 'error' ? 'mt-0.5 text-critical' : 'mt-0.5 text-accent'}>
                {t.tone === 'error' ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />}
              </span>
              <p className="flex-1 text-sm leading-5 text-ink">{t.message}</p>
              <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-ink-faint transition-colors hover:text-ink">
                <X size={16} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as motion from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { ArrowBendDownLeft, MagnifyingGlass, SignOut } from '@phosphor-icons/react';
import { NAV_ITEMS } from '../lib/nav';
import { cn } from '../lib/cn';
import { spring } from './ui/motion';

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  run: () => void;
}

/** Cmd/Ctrl+K: jump to any page or sign out without leaving the keyboard. */
export function CommandPalette({ open, onClose, onSignOut }: { open: boolean; onClose: () => void; onSignOut: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((n) => ({ id: n.href, label: n.label, hint: 'Go to', icon: <n.icon size={18} />, run: () => router.push(n.href) })),
      { id: 'signout', label: 'Sign out', hint: 'Session', icon: <SignOut size={18} />, run: onSignOut },
    ],
    [router, onSignOut]
  );
  const results = useMemo(() => commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase())), [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
    if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
    if (e.key === 'Enter' && results[active]) {
      onClose();
      results[active]!.run();
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[16vh] backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={spring}
            onKeyDown={onKeyDown}
            className="w-full max-w-lg overflow-hidden rounded-2xl bg-raised shadow-float ring-1 ring-line-strong"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <MagnifyingGlass size={18} className="text-ink-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Jump to a page"
                aria-label="Search commands"
                className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
              />
            </div>
            <ul className="max-h-72 overflow-y-auto p-1.5">
              {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-faint">Nothing matches.</li>}
              {results.map((c, i) => (
                <li key={c.id}>
                  <button
                    onMouseMove={() => setActive(i)}
                    onClick={() => {
                      onClose();
                      c.run();
                    }}
                    className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors', i === active ? 'bg-white/[0.07] text-ink' : 'text-ink-dim')}
                  >
                    <span className="text-ink-faint">{c.icon}</span>
                    <span className="flex-1">{c.label}</span>
                    <span className="text-xs text-ink-faint">{c.hint}</span>
                    {i === active && <ArrowBendDownLeft size={14} className="text-ink-faint" />}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

'use client';

import { IconContext } from '@phosphor-icons/react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import { ToastProvider } from './ui';

/**
 * App-wide context, mounted once: light-weight icon strokes, the motion runtime (domMax: layout animations for the
 * nav indicator), reduced-motion respected for anyone who asked their OS for it, and toasts.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <IconContext.Provider value={{ weight: 'light', size: 18 }}>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={domMax} strict>
          <ToastProvider>{children}</ToastProvider>
        </LazyMotion>
      </MotionConfig>
    </IconContext.Provider>
  );
}

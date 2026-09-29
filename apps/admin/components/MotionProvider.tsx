'use client';

import { LazyMotion, domAnimation } from 'motion/react';

/** Loads only the DOM animation features once; components use the lightweight `m` (motion/react-m). */
export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={domAnimation}>{children}</LazyMotion>;
}

'use client';

import { useEffect } from 'react';
import * as motion from 'motion/react-m';
import { animate, useMotionValue, useTransform } from 'motion/react';
import { ease } from './motion';

/** A number that eases up to its value when it first appears and whenever the value changes. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease });
    return () => controls.stop();
  }, [mv, value]);
  return <motion.span className={className}>{text}</motion.span>;
}

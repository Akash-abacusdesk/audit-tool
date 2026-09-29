/** One easing and one spring for the whole console, so every surface moves like the same physical material. */
export const ease = [0.32, 0.72, 0, 1] as const;
export const spring = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

export const rise = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease } },
};

/** Parent variant: children using `rise` reveal one after another. */
export const stagger = (gap = 0.05) => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: 0.05 } },
});

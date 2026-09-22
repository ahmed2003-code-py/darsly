import { HTMLMotionProps, m, useReducedMotion, Variants } from 'framer-motion';
import { ReactNode, useState } from 'react';
import { useThemeLayout } from '../lib/useThemeLayout';

/**
 * Shared motion primitives. One curve (easeOutExpo), short durations, small
 * translateY — subtle and fast, never bouncy. All reveals fire once on
 * scroll-in and collapse to a no-op under prefers-reduced-motion.
 *
 * The theme sets how much of it there is. `still` is none — not slower, none,
 * the same as reduced motion. `subtle` is the app as it was. `expressive` is a
 * touch further and a touch longer, which is as far as "premium" should ever
 * go: motion that draws attention to itself is motion that is in the way. The
 * reader's own preference always wins over the theme's.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

/** How far and how long, for the theme's motion level. */
const LEVELS: Record<string, { scale: number; dur: number }> = {
  still: { scale: 0, dur: 0 },
  subtle: { scale: 1, dur: 0.26 },
  expressive: { scale: 1.35, dur: 0.36 },
};

/**
 * The theme's motion level, resolved against the reader's preference.
 *
 * `off` is what both `still` and reduced-motion mean: no entrance, no lift.
 * Everything else scales the distance and the duration together.
 */
export function useMotion(): { off: boolean; scale: number; dur: number } {
  const reduce = useReducedMotion();
  const { motion } = useThemeLayout();
  const level = LEVELS[motion] ?? LEVELS.subtle;
  const off = !!reduce || level.scale === 0;
  return { off, scale: off ? 0 : level.scale, dur: off ? 0 : level.dur };
}

/** Fade + small rise, once on scroll-in. `delay` in seconds for hand-placed items. */
export function Reveal({
  children,
  delay = 0,
  y = 12,
  className,
  as = 'div',
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  as?: keyof typeof m;
}) {
  const { off, scale, dur } = useMotion();
  const Comp = (m as any)[as] as typeof m.div;
  return (
    <Comp
      className={className}
      initial={off ? false : { opacity: 0, y: y * scale }}
      whileInView={off ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: dur, ease: EASE, delay }}
    >
      {children}
    </Comp>
  );
}

/**
 * Wrap a list; children using <StaggerItem> reveal with a ~50ms cascade.
 *
 * The revealed state is held in React state rather than left to `whileInView`.
 * With `once: true` the observer stops watching after it fires, so a child that
 * mounts *later* — a list re-keyed by a re-render, which is what switching
 * language does — arrived at the hidden variant with nothing left to move it,
 * and stayed invisible until the page was reloaded. Driving `animate` from
 * state means the container is authoritative: whatever mounts under a revealed
 * container is revealed too.
 */
export function Stagger({
  children,
  className,
  gap = 0.05,
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
}) {
  const { off, scale } = useMotion();
  const [revealed, setRevealed] = useState(false);
  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: off ? 0 : gap * scale } },
  };
  return (
    <m.div
      className={className}
      variants={container}
      initial={off ? false : 'hidden'}
      animate={off || revealed ? 'show' : 'hidden'}
      onViewportEnter={() => setRevealed(true)}
      viewport={{ once: true, margin: '-40px' }}
    >
      {children}
    </m.div>
  );
}

export function StaggerItem({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  const { scale, dur } = useMotion();
  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 12 * scale },
    show: { opacity: 1, y: 0, transition: { duration: dur, ease: EASE } },
  };
  return (
    <m.div className={className} variants={itemVariants} {...rest}>
      {children}
    </m.div>
  );
}


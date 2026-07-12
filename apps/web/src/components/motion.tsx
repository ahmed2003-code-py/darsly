import { HTMLMotionProps, motion, useReducedMotion, Variants } from 'framer-motion';
import { ReactNode } from 'react';

/**
 * Shared motion primitives. One curve (easeOutExpo), short durations, small
 * translateY — subtle and fast, never bouncy. All reveals fire once on scroll-in
 * and collapse to a no-op under prefers-reduced-motion.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

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
  as?: keyof typeof motion;
}) {
  const reduce = useReducedMotion();
  const Comp = motion[as] as typeof motion.div;
  return (
    <Comp
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.26, ease: EASE, delay }}
    >
      {children}
    </Comp>
  );
}

/** Wrap a list; children using <StaggerItem> reveal with a ~50ms cascade. */
export function Stagger({
  children,
  className,
  gap = 0.05,
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
}) {
  const reduce = useReducedMotion();
  const container: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : gap } },
  };
  return (
    <motion.div
      className={className}
      variants={container}
      initial={reduce ? false : 'hidden'}
      whileInView={reduce ? undefined : 'show'}
      viewport={{ once: true, margin: '-40px' }}
    >
      {children}
    </motion.div>
  );
}

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.26, ease: EASE } },
};

export function StaggerItem({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div className={className} variants={itemVariants} {...rest}>
      {children}
    </motion.div>
  );
}

/** Subtle press/hover affordance for interactive cards (transform only). */
export const hoverLift = {
  whileHover: { y: -2 },
  whileTap: { scale: 0.99 },
  transition: { duration: 0.2, ease: EASE },
};

import { DesignSpec } from '../../schema/design-spec';
import { LT, RenderContext } from '../types';

/**
 * What every pattern receives. It is the caller's render context plus the two
 * things only the compiler can know: the design system in force, and where a
 * call to action is allowed to send a visitor.
 */
export interface ComposeContext extends RenderContext {
  design: DesignSpec;
  /**
   * The one destination every button on the page uses.
   *
   * Patterns must never invent a href. The compiler resolves this once because
   * only it can see the whole page, and because a layout that guesses is how
   * "ابدأ الآن" came to point at an element that never existed.
   */
  ctaHref: string;
  /** Request a client behaviour (parallax, counters…). Emitted once per page. */
  useEffect: (id: string) => void;
  /** Request a decorative CSS module by id. Emitted once per page. */
  useDecor: (id: string) => void;
}

export type { LT };

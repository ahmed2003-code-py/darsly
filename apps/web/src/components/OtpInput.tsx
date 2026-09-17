import { useId, useRef, useState } from 'react';
import { useMotion } from './motion';

/**
 * A code, entered as a hand of cards.
 *
 * Six identical boxes in a row is the honest way to ask for a code and the
 * dullest: nothing about it says how many are left, and a filled box looks the
 * same as an empty one until you read it. So the slots are dealt as a fan —
 * every card is rotated about a single pivot sitting well below the row, which
 * is what makes them splay along one arc instead of looking like six boxes
 * somebody tilted by hand — and a digit *lands* its card: it straightens, lifts
 * out of the fan and takes the ink colour. The shape of the hand tells you how
 * far along you are before you have read a single number.
 *
 * One real input underneath owns the value. That is not an implementation
 * detail — it is what keeps paste, the SMS autofill an `one-time-code` field
 * gets for free, and the numeric keyboard on a phone all working. Six separate
 * inputs would have had to reimplement each of those, badly.
 *
 * Colours are the app's own tokens throughout, so a published academy palette
 * repaints this like everything else, and it reads in both light and dark.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const motion = useMotion();

  const digits = value.replace(/\D/g, '').slice(0, length);
  const cards = Array.from({ length }, (_, i) => digits[i] ?? '');
  const next = digits.length;

  /**
   * How far each card is turned, in degrees.
   *
   * Symmetrical about the middle, so the hand is balanced whether the code is
   * four digits or six. `off` flattens it completely: reduced motion should not
   * mean "the same thing, slower", it should mean a plain row.
   */
  const spread = motion.off ? 0 : 4.5;
  const angle = (i: number) => (i - (length - 1) / 2) * spread;

  return (
    <div className="mb-5">
      {/* The pivot is set on the cards themselves, far below their own box, so
          one rotation produces the arc. Nothing here is positioned by hand. */}
      {/* `dir="ltr"` is not decoration. The page is right-to-left, so without it
          the row lays the cards right-to-left too and a code typed 4-8-2-1
          reads back as 1-2-8-4 — the digits were correct and the order was a
          lie. A code is a number; numbers run left to right in Arabic as well. */}
      <div
        dir="ltr"
        className="relative flex select-none justify-center gap-2 py-4"
        onClick={() => ref.current?.focus()}
      >
        {cards.map((d, i) => {
          const filled = d !== '';
          const isNext = focused && i === next;
          return (
            <span
              key={i}
              aria-hidden
              style={{
                transformOrigin: '50% 260%',
                transform: motion.off
                  ? undefined
                  : `rotate(${filled ? 0 : angle(i)}deg) translateY(${filled ? -6 : 0}px)`,
                transitionDuration: `${motion.dur * 420}ms`,
              }}
              className={`grid h-14 w-11 place-items-center rounded-xl border text-2xl font-bold tabular-nums transition-all ease-out sm:h-16 sm:w-12 ${
                filled
                  ? 'border-primary/40 bg-surface-container-lowest text-on-surface shadow-sm'
                  : isNext
                    ? 'border-primary bg-primary-fixed/30 text-outline'
                    : 'border-outline-variant bg-surface-container-low text-outline'
              }`}
            >
              {d || (isNext ? <span className="h-5 w-px animate-pulse bg-primary" /> : '')}
            </span>
          );
        })}

        {/* The field itself: present for every assistive technology and every
            autofill path, invisible to the eye. Not `hidden`, which would take
            it out of all of them. */}
        <input
          ref={ref}
          id={id}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={digits}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={length}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          dir="ltr"
        />
      </div>
    </div>
  );
}

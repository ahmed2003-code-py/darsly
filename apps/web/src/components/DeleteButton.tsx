import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMotion } from './motion';

type Phase = 'idle' | 'armed' | 'working' | 'done';

/**
 * Delete, as one movement instead of a dialog.
 *
 * A destructive action wants two things that usually fight: it must be hard to
 * do by accident, and it must not feel like paperwork. A confirm dialog buys
 * the first with the second — it stops the page, asks a question nobody reads,
 * and is dismissed by muscle memory.
 *
 * So the button arms itself instead. The first press opens the bin and the
 * label changes to the question; the second press *feeds the label to it* —
 * the word slides into the bin, the pill collapses to a disc around it, and the
 * request goes while an arc sweeps the rim. Nothing is deleted until the second
 * press, an armed button disarms itself after a few seconds of being ignored,
 * and pressing anywhere else disarms it too.
 *
 * The whole thing is one control, so it stays where the row is and takes no
 * layout with it. Under reduced motion it is a plain two-press button, which is
 * the same safety with none of the theatre.
 */
export function DeleteButton({
  onConfirm,
  label,
  confirmLabel,
  className = '',
  disabled,
  compact,
}: {
  onConfirm: () => Promise<unknown> | unknown;
  label?: string;
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Icon only until armed — for a row of actions with no room for a word. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const motion = useMotion();
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPhase('idle');
  };

  // An armed button left alone is a button somebody walked away from.
  const arm = () => {
    setPhase('armed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => alive.current && setPhase('idle'), 4000);
  };

  async function press() {
    if (disabled || phase === 'working') return;
    if (phase === 'idle') return arm();
    if (timer.current) clearTimeout(timer.current);
    setPhase('working');
    try {
      await onConfirm();
      if (!alive.current) return;
      setPhase('done');
      // Long enough to be seen, short enough that a list of rows does not sit
      // there flashing at somebody deleting several things.
      timer.current = setTimeout(() => alive.current && setPhase('idle'), 900);
    } catch {
      // The caller surfaces the error; this only has to stop pretending.
      if (alive.current) setPhase('idle');
    }
  }

  const text = phase === 'armed' ? (confirmLabel ?? t('common.confirmDelete')) : (label ?? t('common.delete'));
  const showText = !compact || phase !== 'idle';
  const open = phase === 'armed';
  const eaten = phase === 'working' || phase === 'done';

  return (
    <button
      type="button"
      onClick={press}
      onBlur={() => phase === 'armed' && disarm()}
      disabled={disabled || phase === 'working'}
      aria-label={label ?? t('common.delete')}
      title={label ?? t('common.delete')}
      className={`group relative inline-flex select-none items-center gap-2 overflow-hidden rounded-full border px-3 py-2 text-sm font-bold transition-colors disabled:opacity-60 ${
        phase === 'idle'
          ? 'border-outline-variant text-on-surface-variant hover:border-error/50 hover:text-error'
          : 'border-error bg-error-container text-on-error-container'
      } ${className}`}
      style={{ transitionDuration: `${motion.dur * 260}ms` }}
    >
      {/* The bin. Its lid is a separate line so it can tip, and it tips the
          moment the button is armed — the container is open before anything
          goes into it, which is the whole promise of the gesture. */}
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 overflow-visible" fill="none" aria-hidden>
        <path
          d="M4 7h16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          style={{
            transformOrigin: '20% 60%',
            transform: motion.off ? undefined : `rotate(${open || eaten ? -22 : 0}deg) translateY(${open || eaten ? -1 : 0}px)`,
            transition: `transform ${motion.dur * 260}ms cubic-bezier(.2,.9,.3,1.3)`,
          }}
        />
        <path d="M10 4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          style={{
            transformOrigin: '20% 60%',
            transform: motion.off ? undefined : `rotate(${open || eaten ? -22 : 0}deg) translateY(${open || eaten ? -1 : 0}px)`,
            transition: `transform ${motion.dur * 260}ms cubic-bezier(.2,.9,.3,1.3)`,
          }}
        />
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* What the bin swallowed, rising inside it and settling. */}
        {eaten && !motion.off && (
          <rect x="7.5" y="10" width="9" height="9" rx="1.5" fill="currentColor" opacity="0.9">
            <animate attributeName="y" from="19" to="11" dur="0.42s" fill="freeze" />
            <animate attributeName="height" from="0" to="8" dur="0.42s" fill="freeze" />
          </rect>
        )}
      </svg>

      {/* The label is what gets eaten: it slides down into the bin and the
          button closes over the space it left. */}
      {showText && (
        <span
          className="whitespace-nowrap"
          style={{
            display: 'inline-block',
            transform: motion.off ? undefined : eaten ? 'translateY(14px) scale(.6)' : 'none',
            opacity: eaten ? 0 : 1,
            maxWidth: eaten && !motion.off ? 0 : '12rem',
            transition: `transform ${motion.dur * 320}ms cubic-bezier(.4,0,.2,1), opacity ${motion.dur * 200}ms linear, max-width ${motion.dur * 320}ms cubic-bezier(.4,0,.2,1)`,
          }}
        >
          {text}
        </span>
      )}

      {/* The wait, drawn on the rim rather than as a spinner somewhere else —
          the button is the thing that is busy. */}
      {phase === 'working' && (
        <span className="pointer-events-none absolute inset-0 rounded-full border-2 border-transparent border-t-error motion-safe:animate-spin" />
      )}
    </button>
  );
}

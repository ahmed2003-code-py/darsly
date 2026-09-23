import { m } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react';
import { Reveal } from './motion';
import i18n from '../i18n';
import { errorMessage } from '../lib/errorMessage';

/** Small building blocks shared across screens. */

/** What Tab can reach inside a dialog. `[tabindex="-1"]` is excluded on
 *  purpose: it is programmatically focusable but not part of the tab order,
 *  and the panel itself carries it. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Badge({
  children,
  tone = 'primary',
}: {
  children: ReactNode;
  tone?: 'primary' | 'teal' | 'warn' | 'error' | 'neutral';
}) {
  const tones: Record<string, string> = {
    // 'teal' kept for API compatibility but now reads as the single accent.
    primary: 'bg-primary-fixed text-on-primary-fixed-variant ring-1 ring-inset ring-accent-600/10',
    teal: 'bg-primary-fixed text-on-primary-fixed-variant ring-1 ring-inset ring-accent-600/10',
    warn: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/15',
    error: 'bg-error-container text-on-error-container ring-1 ring-inset ring-error/15',
    neutral: 'bg-surface-container-high text-on-surface-variant',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-xs text-outline">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-primary" dir="ltr">
      <span className="font-heading font-bold text-on-surface">{rating}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 17.3l-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7z" />
      </svg>
    </span>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-primary-fixed border-t-primary" />
    </div>
  );
}

/** Shimmering placeholder block. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/** A grid of card skeletons for list screens while data loads. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card space-y-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-14 w-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex items-center justify-between pt-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Page header with a hand-placed accent rule, a confident fluid title, and an
 * optional end-aligned action. Reveals on mount.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <Reveal className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex items-center gap-2">
            <span className="h-px w-6 bg-primary" />
            <span className="font-heading text-xs font-semibold uppercase tracking-widest text-primary">
              {eyebrow}
            </span>
          </div>
        )}
        <h1 className="display text-on-surface">{title}</h1>
        {subtitle && <p className="mt-2 max-w-xl text-on-surface-variant">{subtitle}</p>}
      </div>
      {/* `shrink-0` keeps the action from being squashed beside the title, but on
          a phone that same rule let a pair of buttons set the page width and push
          everything else off the right edge. Below `sm` it takes the line it is
          already wrapping onto, and its own contents wrap inside it. */}
      {action && <div className="w-full shrink-0 sm:w-auto">{action}</div>}
    </Reveal>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 py-16 text-center">
      <span className="material-symbols-outlined text-5xl text-outline-variant">{icon}</span>
      <p className="font-heading text-lg font-semibold text-on-surface-variant">{title}</p>
      {hint && <p className="text-sm text-outline">{hint}</p>}
    </div>
  );
}

/**
 * The dialog the whole app uses — now one a keyboard can actually operate.
 *
 * It looked like a dialog and behaved like a `<div>`: no `role`, no
 * `aria-modal`, no focus management, no Escape. A screen reader announced
 * nothing, and Tab walked straight out of the panel and into the page behind
 * it, where everything is still focusable but nothing is visible. Since this
 * is the modal nearly every screen reaches for, that was the app's single
 * largest accessibility gap.
 *
 * Four things, each the minimum that makes the pattern correct:
 *
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby`, so it is announced,
 *    and announced *by its own title* rather than as an unnamed region.
 *  - Focus moves into the panel on open. Without it a keyboard user is still
 *    outside, tabbing through a page they cannot see.
 *  - Tab is cycled inside the panel, so focus cannot escape while it is open.
 *  - Escape closes, and focus returns to whatever opened it — otherwise the
 *    caret restarts at the top of the document on every close.
 *
 * `aria-hidden` on the backdrop is deliberately not used: it would hide the
 * panel too, since the panel is inside it.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Whatever had focus when this opened, so it can be given back on close.
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;

    // The panel itself, rather than its first control: a dialog that opens with
    // the cursor already in a text field reads its label instead of its title,
    // and the reader never learns what they are being asked.
    const focusPanel = requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      cancelAnimationFrame(focusPanel);
      // Only take focus back if it is still inside the dialog being torn down;
      // if something else has claimed it since, stealing it would be worse.
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) {
        (openerRef.current as HTMLElement | null)?.focus?.();
      }
    };
  }, [open]);

  /**
   * Keys are handled on the panel, not on `document`.
   *
   * A document-level listener would fire before anything inside the dialog —
   * so an inline editor that cancels on Escape would never get the chance, and
   * with two dialogs open both would close at once. Here the event bubbles
   * from whatever is focused, so the innermost handler decides first and this
   * only sees what nobody else claimed. Focus is trapped inside the panel, so
   * it always bubbles through.
   */
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
    );
    if (!focusable.length) {
      // Nothing to move between — keep focus on the panel rather than letting
      // Tab wander into the page behind.
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    // Wrapping both ways, and treating "focus is on the panel" as being at the
    // start, which is where it begins.
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;
  return (
    <m.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-inverse-surface/40 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <m.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`modal-panel max-h-[90vh] w-full overflow-y-auto rounded-3xl border border-outline-variant bg-surface-container-lowest p-6 shadow-modal outline-none ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id={titleId} className="font-heading text-xl font-bold tracking-tight">
            {title}
          </h3>
          <button
            className="grid h-9 w-9 place-items-center rounded-full text-outline transition-colors hover:bg-surface-container-low hover:text-on-surface"
            onClick={onClose}
            aria-label={i18n.t('common.close')}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        {children}
      </m.div>
    </m.div>
  );
}

export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  /** Marks the field (red edge, via `.field-invalid` in index.css) and says why, under it. */
  error?: ReactNode;
}) {
  return (
    <label className={`mb-4 block ${error ? 'field-invalid' : ''}`}>
      <span
        className={`mb-1.5 block text-sm font-semibold ${error ? 'text-error' : 'text-on-surface-variant'}`}
      >
        {label}
      </span>
      {children}
      {error && (
        <span role="alert" className="mt-1.5 flex items-start gap-1 text-sm text-error">
          <span className="material-symbols-outlined mt-px text-[18px]">error</span>
          <span className="min-w-0">{error}</span>
        </span>
      )}
      {hint && <span className="mt-1 block text-sm text-outline">{hint}</span>}
    </label>
  );
}

/**
 * How far along something is.
 *
 * `tone="gold"` is for progress through a level: XP is drawn in one colour
 * across the app, and a bar filling with it is the clearest statement of that.
 * Everything else — a video part-watched, a file uploading — is the brand
 * colour, because it is progress through a task rather than something earned.
 */
export function ProgressBar({ pct, tone }: { pct: number; tone?: 'accent' | 'primary' | 'gold' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-premium ${
          tone === 'gold' ? 'bg-student-gold' : 'bg-primary'
        }`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

/**
 * A refusal in its own place — under the form that caused it.
 *
 * The wording is resolved by `lib/errorMessage`, the single place that decides
 * what a failure says; this component only decides where it sits. The same
 * resolver feeds the toasts, so an error reads identically whether it is shown
 * inline or over the page.
 */
export function ErrorNote({ error }: { error: unknown }) {
  // Re-render in the new language when it changes; the resolver reads i18n
  // directly, so without this a note left on screen would keep the old copy.
  useTranslation();
  if (!error) return null;
  const message = errorMessage(error);
  if (!message) return null;
  return (
    <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
      {message}
    </p>
  );
}

/** Dependency-free bar chart (keeps the bundle lean — no charting library). */
export function BarChart({
  data,
  format,
}: {
  data: { label: string; value: number }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-44 items-end gap-3 pt-6">
      {data.map((d, i) => {
        const h = (d.value / max) * 100;
        return (
          <div key={i} className="group flex flex-1 flex-col items-center gap-2">
            <div className="relative flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t-lg bg-primary transition-all duration-500 group-hover:opacity-90"
                style={{ height: `${Math.max(2, h)}%` }}
              />
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold text-on-surface-variant opacity-0 transition group-hover:opacity-100">
                {format ? format(d.value) : d.value}
              </span>
            </div>
            <span className="text-xs text-outline">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

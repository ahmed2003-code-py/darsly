import { motion } from 'framer-motion';
import { ReactNode } from 'react';
import { Reveal } from './motion';

/** Small building blocks shared across screens. */

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
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}>
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
      {action && <div className="shrink-0">{action}</div>}
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
  if (!open) return null;
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-inverse-surface/40 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-3xl border border-outline-variant bg-surface-container-lowest p-6 shadow-modal ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-heading text-xl font-bold tracking-tight">{title}</h3>
          <button
            className="grid h-9 w-9 place-items-center rounded-full text-outline transition-colors hover:bg-surface-container-low hover:text-on-surface"
            onClick={onClose}
            aria-label="إغلاق"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-outline">{hint}</span>}
    </label>
  );
}

export function ProgressBar({ pct }: { pct: number; tone?: 'accent' | 'primary' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-premium"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    (error as any)?.response?.data?.message?.toString?.() ??
    (error as any)?.message ??
    String(error);
  return (
    <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
      {message}
    </p>
  );
}

import { ReactNode } from 'react';

/** Small building blocks shared by the Phase 2 screens. */

export function Badge({
  children,
  tone = 'primary',
}: {
  children: ReactNode;
  tone?: 'primary' | 'teal' | 'warn' | 'error' | 'neutral';
}) {
  const tones: Record<string, string> = {
    primary: 'bg-primary-fixed text-on-primary-fixed-variant',
    teal: 'bg-secondary-container text-on-secondary-fixed',
    warn: 'bg-amber-100 text-amber-800',
    error: 'bg-error-container text-on-error-container',
    neutral: 'bg-surface-container-high text-on-surface-variant',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-xs text-outline">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-accent" dir="ltr">
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
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary-fixed border-t-primary" />
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
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Page header block used across screens for a consistent title/subtitle rhythm. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-heading text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-on-surface-variant">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 py-16 text-center">
      <span className="material-symbols-outlined text-5xl text-outline-variant">{icon}</span>
      <p className="font-heading text-lg font-bold text-on-surface-variant">{title}</p>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-on-surface/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`max-h-[90vh] w-full overflow-y-auto rounded-xl bg-surface-container-lowest p-6 shadow-modal ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-heading text-xl font-bold">{title}</h3>
          <button className="text-outline hover:text-on-surface" onClick={onClose} aria-label="close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-bold text-on-surface-variant">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-outline">{hint}</span>}
    </label>
  );
}

export function ProgressBar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'primary' }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
      <div
        className={`h-full rounded-full transition-all ${tone === 'accent' ? 'bg-accent' : 'bg-primary-container'}`}
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
    <p className="mt-3 rounded-md bg-error-container px-4 py-2 text-sm text-on-error-container">
      {message}
    </p>
  );
}

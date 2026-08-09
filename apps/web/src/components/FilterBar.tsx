import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The filter surface, shared by both catalogues.
 *
 * It used to be a 260px column pinned beside the results on every screen — a
 * third of a laptop window permanently spent on controls a student touches once
 * and then wants out of the way. Everything now lives in one line: the filter
 * students actually reach for as chips, and the rest behind a button that opens
 * a sheet over the page.
 *
 * What replaces the always-visible panel is the row of active filters beneath
 * it. A hidden panel is only acceptable if you can always see what it is doing.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

export interface Chip {
  id: string;
  label: string;
}

export interface ActiveChip {
  key: string;
  label: string;
}

export function FilterBar({
  chips,
  selectedChip,
  onChip,
  search,
  onSearch,
  searchPlaceholder,
  sort,
  onSort,
  sorts,
  sortLabel,
  activeCount,
  activeChips,
  onRemove,
  onClear,
  onOpen,
  busy,
}: {
  chips: Chip[];
  selectedChip: string;
  onChip: (id: string) => void;
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder: string;
  sort: string;
  onSort: (v: string) => void;
  sorts: { value: string; label: string }[];
  sortLabel: string;
  activeCount: number;
  activeChips: ActiveChip[];
  onRemove: (key: string) => void;
  onClear: () => void;
  onOpen: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  return (
    <div className="mb-6 space-y-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative flex-1">
          <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-4 my-auto h-fit text-[20px] text-outline">
            search
          </span>
          <input
            className="input h-12 ps-12 text-base"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {busy && (
            <span className="absolute inset-y-0 end-4 my-auto h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
          )}
        </label>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={onOpen}
            className="btn-secondary h-12 shrink-0"
            aria-haspopup="dialog"
          >
            <span className="material-symbols-outlined text-[20px]">tune</span>
            {t('filters.button')}
            {activeCount > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-on-primary">
                {activeCount}
              </span>
            )}
          </button>
          <select
            className="input h-12 w-auto min-w-[9rem]"
            value={sort}
            onChange={(e) => onSort(e.target.value)}
            aria-label={sortLabel}
          >
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* The one filter worth a permanent place. Horizontally scrollable rather
          than wrapping to three rows on a phone. */}
      {chips.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ChipButton on={!selectedChip} onClick={() => onChip('')}>
            {t('filters.all')}
          </ChipButton>
          {chips.map((c) => (
            <ChipButton key={c.id} on={selectedChip === c.id} onClick={() => onChip(c.id)}>
              {c.label}
            </ChipButton>
          ))}
        </div>
      )}

      {/* Everything currently narrowing the results, removable one at a time.
          This is what makes hiding the panel safe. */}
      <AnimatePresence initial={false}>
        {activeChips.length > 0 && (
          <m.div
            className="flex flex-wrap items-center gap-2"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
          >
            {activeChips.map((a) => (
              <m.button
                key={a.key}
                layout={!reduce}
                onClick={() => onRemove(a.key)}
                className="flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 py-1 text-xs font-semibold text-on-surface-variant transition-colors hover:border-error/40 hover:text-error"
              >
                {a.label}
                <span className="material-symbols-outlined text-[14px]">close</span>
              </m.button>
            ))}
            <button className="text-xs font-semibold text-primary hover:underline" onClick={onClear}>
              {t('filters.clear')}
            </button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChipButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <m.button
      onClick={onClick}
      aria-pressed={on}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      className={`shrink-0 whitespace-nowrap rounded-xl px-4 py-2 font-heading text-sm font-semibold transition-colors ${
        on
          ? 'bg-primary text-on-primary'
          : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
      }`}
    >
      {children}
    </m.button>
  );
}

/**
 * The sheet the rest of the filters live in.
 *
 * Slides from the page's inline-end so it reads the same in both directions,
 * and closes on Escape or on the backdrop — a panel you cannot dismiss quickly
 * is worse than one that was never hidden.
 */
export function FilterSheet({
  open,
  onClose,
  onApply,
  children,
  count,
}: {
  open: boolean;
  onClose: () => void;
  onApply?: () => void;
  children: ReactNode;
  count: number;
}) {
  const { t, i18n } = useTranslation();
  const reduce = useReducedMotion();
  // The sheet is anchored to the page's inline-end, so it has to travel out
  // through that same edge. Hard-coding `100%` slid the Arabic panel in from
  // the middle of the screen.
  const off = i18n.dir() === 'rtl' ? '-100%' : '100%';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            className="fixed inset-0 z-40 bg-inverse-surface/40 backdrop-blur-[2px]"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />
          <m.aside
            role="dialog"
            aria-modal="true"
            aria-label={t('filters.button')}
            className="fixed inset-y-0 z-50 flex w-full max-w-sm flex-col bg-surface-container-lowest shadow-elevated ltr:right-0 rtl:left-0"
            initial={reduce ? false : { x: off }}
            animate={{ x: 0 }}
            exit={reduce ? undefined : { x: off }}
            transition={{ duration: 0.32, ease: EASE }}
          >
            <header className="flex items-center justify-between border-b border-outline-variant px-5 py-4">
              <h2 className="flex items-center gap-2 font-heading text-lg font-bold">
                <span className="material-symbols-outlined text-[20px]">tune</span>
                {t('filters.button')}
                {count > 0 && (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-on-primary">{count}</span>
                )}
              </h2>
              <button
                onClick={onClose}
                aria-label={t('filters.close')}
                className="grid h-9 w-9 place-items-center rounded-xl text-on-surface-variant transition-colors hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

            <footer className="border-t border-outline-variant px-5 py-4">
              <button className="btn-primary w-full" onClick={onApply ?? onClose}>
                {t('filters.show')}
              </button>
            </footer>
          </m.aside>
        </>
      )}
    </AnimatePresence>
  );
}

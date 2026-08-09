import { useTranslation } from 'react-i18next';

/**
 * Paging, shared by every catalogue on the platform.
 *
 * The ends are always reachable and the middle collapses, so a hundred pages
 * still renders as one row rather than a hundred buttons. Both discovery pages
 * use this: two lists that page differently read as two products.
 */
export default function Pager({
  page,
  pages,
  onGo,
}: {
  page: number;
  pages: number;
  onGo: (p: number) => void;
}) {
  const { t } = useTranslation();
  if (pages <= 1) return null;

  const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const shown = [...new Set([1, ...around, pages])].sort((a, b) => a - b);

  const arrow = (dir: 'prev' | 'next') => (
    <button
      className="grid h-10 w-10 place-items-center rounded-xl border border-outline-variant text-on-surface-variant transition-colors hover:bg-surface-container-low disabled:pointer-events-none disabled:opacity-40"
      onClick={() => onGo(dir === 'prev' ? page - 1 : page + 1)}
      disabled={dir === 'prev' ? page <= 1 : page >= pages}
      aria-label={t(`pager.${dir}`)}
    >
      <span className="material-symbols-outlined text-[20px] rtl:-scale-x-100">
        {dir === 'prev' ? 'chevron_left' : 'chevron_right'}
      </span>
    </button>
  );

  return (
    <nav className="mt-10 flex flex-wrap items-center justify-center gap-1.5" aria-label={t('pager.label')}>
      {arrow('prev')}
      {shown.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - shown[i - 1] > 1 && <span className="px-1 text-outline">…</span>}
          <button
            onClick={() => onGo(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`h-10 min-w-10 rounded-xl px-3 font-heading text-sm font-semibold transition-colors ${
              p === page
                ? 'bg-primary text-on-primary'
                : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            {p}
          </button>
        </span>
      ))}
      {arrow('next')}
    </nav>
  );
}

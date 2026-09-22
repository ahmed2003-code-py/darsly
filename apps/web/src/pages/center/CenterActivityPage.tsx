import { useTranslation } from 'react-i18next';
import { useOwnedAcademy } from '../../lib/academy';
import { useCenterActivity } from '../../lib/analytics';
import { dateShort } from '../../lib/format';
import { EmptyState, PageHeader, Skeleton } from '../../components/ui';

/**
 * Phase 8: the Center's own audit trail — everything already logged through
 * AuditService across member/course/cash/payout/settings actions, scoped to
 * this Center only (server-enforced; never a client-chosen academy). Owners
 * already have a 10-row taste of this on the dashboard; this is the full,
 * paginated history.
 */
export default function CenterActivityPage() {
  const { t } = useTranslation();
  const { academy, isLoading: loadingAcademy } = useOwnedAcademy();
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useCenterActivity();

  if (loadingAcademy) return <div className="page"><Skeleton className="h-32 rounded-2xl" /></div>;
  if (!academy) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;

  const rows = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <PageHeader title={t('center.activity.title')} subtitle={academy.name} />
      {isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : rows.length === 0 ? (
        <EmptyState icon="history" title={t('center.activity.empty')} />
      ) : (
        <div className="card p-0">
          <ul className="divide-y divide-outline-variant">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <code className="rounded bg-surface-container-low px-1.5 py-0.5 text-xs">{r.action}</code>
                    {r.actor ? <span className="ms-2 text-on-surface-variant">— {r.actor.fullName}</span> : null}
                  </p>
                  {r.entity && (
                    <p className="truncate text-xs text-outline">{r.entity}{r.entityId ? ` · ${r.entityId}` : ''}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-outline">{dateShort(r.createdAt)}</span>
              </li>
            ))}
          </ul>
          {hasNextPage && (
            <div className="border-t border-outline-variant p-4 text-center">
              <button className="btn-secondary" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
                {isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

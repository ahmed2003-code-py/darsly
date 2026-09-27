import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { confirmDelete } from '../../lib/confirm';
import { EmptyState, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import CommercialTermsPanel from '../../components/admin/CommercialTermsPanel';

type Tab = 'review' | 'refunds' | 'purchases' | 'terms';

/**
 * Darsly finance's desk for Live sales: what needs a person (reviews and
 * refunds sent by hand), every purchase with its frozen split, and the
 * platform's default commercial terms. Every action is one the server checks
 * and audits; nothing here moves money by itself.
 */
export default function AdminLiveCommercePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('review');
  const [status, setStatus] = useState('');

  const summary = useQuery({
    queryKey: ['admin-live-summary'],
    queryFn: async () => (await api.get('/admin/live-commerce/summary')).data,
  });
  const purchases = useQuery({
    queryKey: ['admin-live-purchases', tab, status],
    queryFn: async () =>
      (
        await api.get('/admin/live-commerce/purchases', {
          params: tab === 'review' ? { status: 'NEEDS_REVIEW' } : status ? { status } : {},
        })
      ).data,
    enabled: tab === 'review' || tab === 'purchases',
  });
  const refunds = useQuery({
    queryKey: ['admin-live-refunds'],
    queryFn: async () => (await api.get('/admin/live-commerce/refunds')).data,
    enabled: tab === 'refunds',
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-live-summary'] });
    qc.invalidateQueries({ queryKey: ['admin-live-purchases'] });
    qc.invalidateQueries({ queryKey: ['admin-live-refunds'] });
  };
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) =>
      (await api.post(`/admin/live-commerce/${path}`, body ?? {})).data,
    onSettled: refresh,
  });
  const [transferRef, setTransferRef] = useState<Record<string, string>>({});

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'review', label: t('adminLive.tabs.review'), count: summary.data?.review },
    { id: 'refunds', label: t('adminLive.tabs.refunds'), count: summary.data?.refundRequests },
    { id: 'purchases', label: t('adminLive.tabs.purchases') },
    { id: 'terms', label: t('adminLive.tabs.terms') },
  ];

  const PurchaseRow = ({ p, review }: { p: any; review?: boolean }) => (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-heading font-bold">{p.session.title}</p>
          <p className="text-sm text-on-surface-variant">
            {p.buyerName ?? '—'} · {new Date(p.session.startsAt).toLocaleString('ar-EG')}
          </p>
        </div>
        <span className="rounded-full bg-surface-container px-2.5 py-0.5 text-xs font-bold">
          {t(`adminLive.status.${p.status}`)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-outline">{t('adminLive.paid')}</dt>
          <dd className="tabular-nums">{egp(p.studentPaysCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-outline">{t('adminLive.fee')}</dt>
          <dd className="tabular-nums">
            {egp(p.feeCents)}{' '}
            <span className="text-xs text-outline">({t(`adminTerms.mode.${p.feeMode}`)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-outline">{t('adminLive.teacher')}</dt>
          <dd className="tabular-nums">{egp(p.teacherCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-outline">{t('adminLive.center')}</dt>
          <dd className="tabular-nums">
            {egp(p.centerCents)}
            {p.teacherSharePercent != null && (
              <span className="text-xs text-outline"> ({p.teacherSharePercent}%)</span>
            )}
          </dd>
        </div>
      </dl>
      {p.reviewReason && (
        <p className="text-sm text-on-surface-variant">
          {t('adminLive.reason', { reason: p.reviewReason })}
        </p>
      )}
      {review && (
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={act.isPending}
            onClick={async () =>
              (await confirmDelete({ kind: 'cancel', message: t('adminLive.confirmRelease') })) &&
              act.mutate({ path: `purchases/${p.id}/release` })
            }
          >
            {t('adminLive.release')}
          </button>
          <button
            className="btn-ghost text-error"
            disabled={act.isPending}
            onClick={async () =>
              (await confirmDelete({ kind: 'cancel', message: t('adminLive.confirmRefund') })) &&
              act.mutate({
                path: `purchases/${p.id}/refund`,
                body: { reason: p.reviewReason === 'never started' ? 'NO_SHOW' : 'ADMIN' },
              })
            }
          >
            {t('adminLive.refund')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="page">
      <PageHeader title={t('adminLive.title')} subtitle={t('adminLive.subtitle')} />
      {summary.data && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="card">
            <p className="text-sm text-on-surface-variant">{t('adminLive.pendingPayments')}</p>
            <p className="font-heading text-2xl font-bold">{summary.data.pendingPayments}</p>
          </div>
          <div className="card">
            <p className="text-sm text-on-surface-variant">{t('adminLive.tabs.review')}</p>
            <p className="font-heading text-2xl font-bold">{summary.data.review}</p>
          </div>
          <div className="card">
            <p className="text-sm text-on-surface-variant">{t('adminLive.tabs.refunds')}</p>
            <p className="font-heading text-2xl font-bold">{summary.data.refundRequests}</p>
          </div>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${
              tab === x.id
                ? 'border-primary bg-primary text-on-primary'
                : 'border-outline-variant text-on-surface-variant'
            }`}
            onClick={() => setTab(x.id)}
          >
            {x.label}
            {!!x.count && <span className="ms-1.5 tabular-nums">({x.count})</span>}
          </button>
        ))}
      </div>
      <ErrorNote error={act.error} />

      {tab === 'terms' && (
        <div className="card">
          <p className="mb-3 font-heading font-bold">{t('adminTerms.platformDefault')}</p>
          <CommercialTermsPanel academyId={null} />
        </div>
      )}

      {(tab === 'review' || tab === 'purchases') &&
        (purchases.isLoading ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            {tab === 'purchases' && (
              <select
                className="input w-60"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label={t('adminLive.filter')}
              >
                <option value="">{t('adminLive.allStatuses')}</option>
                {[
                  'HELD',
                  'PAYMENT_PENDING',
                  'CONFIRMED',
                  'DELIVERED',
                  'NEEDS_REVIEW',
                  'CANCELLED_BY_STUDENT',
                  'CANCELLED_BY_TEACHER',
                  'REFUND_PENDING',
                  'REFUNDED',
                  'OVERSOLD',
                  'EXPIRED',
                  'PAYMENT_REJECTED',
                ].map((s) => (
                  <option key={s} value={s}>
                    {t(`adminLive.status.${s}`)}
                  </option>
                ))}
              </select>
            )}
            {!purchases.data?.length ? (
              <EmptyState
                icon="task_alt"
                title={
                  tab === 'review' ? t('adminLive.nothingToReview') : t('adminLive.noPurchases')
                }
              />
            ) : (
              purchases.data.map((p: any) => (
                <PurchaseRow key={p.id} p={p} review={tab === 'review'} />
              ))
            )}
          </div>
        ))}

      {tab === 'refunds' &&
        (refunds.isLoading ? (
          <Spinner />
        ) : !refunds.data?.length ? (
          <EmptyState icon="task_alt" title={t('adminLive.noRefunds')} />
        ) : (
          <div className="space-y-3">
            {refunds.data.map((r: any) => (
              <div key={r.id} className="card space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-heading font-bold">{r.livePurchase.session.title}</p>
                    <p className="text-sm text-on-surface-variant">
                      {r.buyerName ?? '—'}{' '}
                      {r.guest && <span className="text-xs">({t('adminLive.guest')})</span>} ·{' '}
                      {t(`adminLive.refundReason.${r.reason}`)}
                    </p>
                  </div>
                  <div className="text-end">
                    <p className="font-heading text-xl font-bold tabular-nums">
                      {egp(r.amountCents)}
                    </p>
                    <span className="text-xs font-bold">
                      {t(`adminLive.refundStatus.${r.status}`)}
                    </span>
                  </div>
                </div>
                <p className="text-sm">
                  {t(`adminLive.destination.${r.destination}`)}
                  {r.destinationMethod && (
                    <>
                      {' · '}
                      {t(`method.${r.destinationMethod}`)} · {r.destinationDetails?.holderName} ·{' '}
                      <span dir="ltr" className="select-all font-mono">
                        {r.destinationDetails?.handle}
                      </span>
                    </>
                  )}
                  {r.destination === 'MANUAL_TRANSFER' && !r.destinationMethod && (
                    <span className="text-error"> · {t('adminLive.awaitingDestination')}</span>
                  )}
                </p>
                {r.transferReference && (
                  <p className="text-xs text-outline">
                    {t('adminLive.transferRef', { ref: r.transferReference })}
                  </p>
                )}
                {r.status === 'REQUESTED' && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-primary"
                      disabled={act.isPending || !r.destinationMethod}
                      onClick={() => act.mutate({ path: `refunds/${r.id}/approve` })}
                    >
                      {t('adminLive.approve')}
                    </button>
                    <button
                      className="btn-ghost text-error"
                      disabled={act.isPending}
                      onClick={() => {
                        const reason = window.prompt(t('adminLive.rejectReason')) ?? '';
                        if (reason.trim())
                          act.mutate({ path: `refunds/${r.id}/reject`, body: { reason } });
                      }}
                    >
                      {t('adminLive.reject')}
                    </button>
                  </div>
                )}
                {r.status === 'APPROVED' && (
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="input w-56"
                      dir="ltr"
                      placeholder={t('adminLive.transferRefPh')}
                      aria-label={t('adminLive.transferRefPh')}
                      value={transferRef[r.id] ?? ''}
                      onChange={(e) => setTransferRef((m) => ({ ...m, [r.id]: e.target.value }))}
                    />
                    <button
                      className="btn-primary"
                      disabled={act.isPending || (transferRef[r.id] ?? '').trim().length < 3}
                      onClick={async () =>
                        (await confirmDelete({
                          kind: 'cancel',
                          message: t('adminLive.confirmTransferred', {
                            amount: egp(r.amountCents),
                          }),
                        })) &&
                        act.mutate({
                          path: `refunds/${r.id}/complete`,
                          body: { transferReference: transferRef[r.id] },
                        })
                      }
                    >
                      {t('adminLive.markTransferred')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

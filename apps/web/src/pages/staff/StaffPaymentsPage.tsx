import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';
import { dateShort, egp } from '../../lib/format';
import { useAssistantWorkspace, useStaffPayments } from '../../lib/staff';

const STATUSES = ['PENDING', 'PAID', 'REJECTED'] as const;

/**
 * Payments for the assistant's courses — to answer "did my payment arrive?".
 * Read only: no confirming, no collecting, and nothing of the wallet.
 */
export default function StaffPaymentsPage() {
  const { t } = useTranslation();
  const ws = useAssistantWorkspace();
  const [status, setStatus] = useState<string>('PENDING');
  const payments = useStaffPayments(ws.academyId, status);

  return (
    <div className="page">
      <PageHeader title={t('staff.paymentsTitle')} subtitle={t('staff.paymentsSubtitle')} />
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            aria-pressed={status === s}
            className={`rounded-full px-4 py-2 text-sm font-bold transition-colors ${
              status === s
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {t(`staff.paymentStatus.${s}`)}
          </button>
        ))}
      </div>
      {payments.isLoading ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : payments.error ? (
        <ErrorNote error={payments.error} />
      ) : !payments.data?.length ? (
        <EmptyState icon="receipt_long" title={t('staff.noPayments')} />
      ) : (
        <ul className="card divide-y divide-outline-variant/40 p-0">
          {payments.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <bdi className="block truncate font-medium text-on-surface">
                  {p.student?.name ?? '—'}
                </bdi>
                <span className="block truncate text-sm text-on-surface-variant">
                  {p.course?.title} · {dateShort(p.createdAt)}
                </span>
              </div>
              <span className="font-bold text-on-surface" dir="ltr">
                {egp(p.amountCents)}
              </span>
              <Badge
                tone={p.status === 'PAID' ? 'primary' : p.status === 'PENDING' ? 'warn' : 'neutral'}
              >
                {t(`staff.paymentStatus.${p.status}`, p.status)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

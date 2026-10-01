import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeeSummary, useFeesAccess } from '../../lib/centerFees';
import CollectDialog from './CollectDialog';
import { Money } from './feeParts';

/**
 * The desk's fee line under a learner (C4): what they owe, what is overdue,
 * and a Collect button. Separate from attendance on purpose: checking in
 * never waits on money, and money is never taken without a person deciding.
 */
export default function DeskFeeStrip({
  academyId,
  academyStudentId,
}: {
  academyId: string;
  academyStudentId: string;
}) {
  const { t } = useTranslation();
  const access = useFeesAccess(academyId);
  const a = access.data;
  const sum = useFeeSummary(academyId, academyStudentId, !!a?.canView);
  const [collecting, setCollecting] = useState(false);
  if (!a?.canView || !sum.data) return null;
  const s = sum.data;
  return (
    <div
      className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 ${
        s.overdueCents > 0 ? 'border-amber-500/50 bg-amber-500/10' : 'border-outline-variant/50'
      }`}
      aria-label={t('fees.title')}
    >
      <span className="material-symbols-outlined text-xl text-on-surface-variant" aria-hidden>
        payments
      </span>
      {s.outstandingCents === 0 ? (
        <span className="text-sm font-semibold">{t('fees.desk.clear')}</span>
      ) : (
        <span className="min-w-0 flex-1 text-sm">
          {t('fees.owed')}:{' '}
          <Money cents={s.outstandingCents} currency={s.currency} className="font-bold" />
          {s.overdueCents > 0 && (
            <span className="ms-2 font-semibold text-amber-700 dark:text-amber-400">
              · {t('fees.overdue')} <Money cents={s.overdueCents} currency={s.currency} />
            </span>
          )}
        </span>
      )}
      {a.canCollect && s.outstandingCents > 0 && (
        <button
          type="button"
          className="btn-secondary min-h-11 px-4 text-sm font-bold"
          onClick={() => setCollecting(true)}
        >
          {t('fees.collect.action')}
        </button>
      )}
      {collecting && (
        <CollectDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          canReverse={a.canReverse}
          onClose={() => setCollecting(false)}
        />
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';

/**
 * The two rules a buyer should read before paying: what a cancellation gets
 * back, and whether the recording is included. Worded from the server's own
 * policy values, so the card and the refund cannot disagree.
 */
export function RefundAndReplaySummary({
  offer,
}: {
  offer: {
    refundPolicy: string;
    refundWindowHours?: number | null;
    replayPolicy: string;
    replayDays?: number | null;
  };
}) {
  const { t } = useTranslation();
  const hours = offer.refundWindowHours ?? null;
  return (
    <ul className="space-y-1.5 text-sm text-on-surface-variant">
      <li className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[18px] text-primary">undo</span>
        <span>
          {offer.refundPolicy === 'NO_REFUND' || hours == null
            ? t('liveBuy.refund.none')
            : hours >= 48
              ? t('liveBuy.refund.days', { count: Math.round(hours / 24) })
              : t('liveBuy.refund.hours', { count: hours })}
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[18px] text-primary">replay</span>
        <span>
          {offer.replayPolicy === 'NONE'
            ? t('liveBuy.replay.none')
            : offer.replayPolicy === 'INCLUDED_DAYS'
              ? t('liveBuy.replay.days', { count: offer.replayDays ?? 0 })
              : t('liveBuy.replay.forever')}
        </span>
      </li>
    </ul>
  );
}

import { useTranslation } from 'react-i18next';

export type PaymentTarget = 'live' | 'course' | 'topup';

const REVIEW_BODY: Record<PaymentTarget, string> = {
  live: 'livePay.reviewBody',
  course: 'checkout.reviewBodyCourse',
  topup: 'checkout.reviewBodyTopup',
};

/**
 * A transfer of this amount arrived but could not be tied to this buyer by
 * itself — someone at Darsly will. Shown instead of anything that could read
 * as "pay again": the money is here, it only needs a person.
 */
export default function PaymentStageNote({
  stage,
  target,
}: {
  stage?: string | null;
  target: PaymentTarget;
}) {
  const { t } = useTranslation();
  if (stage !== 'UNDER_REVIEW') return null;
  return (
    <p
      className="mb-4 flex items-start gap-2 rounded-xl border border-primary/30 bg-primary-fixed/30 p-3 text-sm"
      role="status"
    >
      <span className="material-symbols-outlined text-primary">fact_check</span>
      <span>
        <span className="block font-bold">{t('livePay.reviewTitle')}</span>
        <span className="block text-xs text-on-surface-variant">{t(REVIEW_BODY[target])}</span>
      </span>
    </p>
  );
}

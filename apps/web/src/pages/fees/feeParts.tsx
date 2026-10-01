import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui';
import { ChargeStatus, formatMoney, parseMoney } from '../../lib/centerFees';

/** An amount, always with its currency and two decimals, read left-to-right. */
export function Money({
  cents,
  currency,
  className = '',
}: {
  cents: number;
  currency: string;
  className?: string;
}) {
  const { i18n } = useTranslation();
  return (
    <bdi dir="ltr" className={`whitespace-nowrap tabular-nums ${className}`}>
      {formatMoney(cents, currency, i18n.language)}
    </bdi>
  );
}

const STATUS_TONE: Record<ChargeStatus, 'primary' | 'warn' | 'neutral'> = {
  PAID: 'primary',
  OVERDUE: 'warn',
  PARTIALLY_PAID: 'warn',
  DUE: 'warn',
  UPCOMING: 'neutral',
  VOID: 'neutral',
};

export function ChargeStatusChip({ status }: { status: ChargeStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`fees.status.${status}`)}</Badge>;
}

/** 'YYYY-MM' as the reader says a month: «أكتوبر 2026» / "October 2026". */
export function monthLabel(period: string, lang: string) {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** 'YYYY-MM-DD' as a short date, read as the calendar date it is (no timezone shift). */
export function dayLabel(date: string, lang: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * A money field: text the receptionist types (Arabic digits welcome), the
 * currency beside it, and — right under it — the amount as it will be taken,
 * so 5000 for 500 is caught before anything is sent.
 */
export function MoneyInput({
  label,
  value,
  onChange,
  currency,
  autoFocus,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  currency: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const cents = parseMoney(value);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          className="input min-h-12 flex-1 text-lg font-bold tabular-nums"
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          aria-invalid={invalid || (!!value && cents == null)}
          aria-describedby={`${id}-read`}
        />
        <span className="grid place-items-center rounded-xl bg-surface-container px-3 text-sm font-bold text-on-surface-variant">
          {currency}
        </span>
      </div>
      <p
        id={`${id}-read`}
        className="mt-1 min-h-5 text-sm text-on-surface-variant"
        aria-live="polite"
      >
        {value && cents == null ? (
          <span className="text-error">{t('fees.money.invalid')}</span>
        ) : cents != null ? (
          <>
            {t('fees.money.reads')} <strong>{formatMoney(cents, currency, i18n.language)}</strong>
          </>
        ) : null}
      </p>
    </div>
  );
}

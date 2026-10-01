import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote } from '../../components/ui';
import { formatClock } from '../../lib/classOps';
import { Receipt, useFeesActions } from '../../lib/centerFees';
import { dayLabel, Money, monthLabel } from './feeParts';
import { printReceipt } from './feePrint';

/**
 * A receipt on screen: a strong "received" state right after a collection,
 * every line it paid, what remains, Print and Done — and, for whoever may,
 * Reverse (with a reason; the receipt stays, marked reversed).
 */
export function ReceiptView({
  receipt: initial,
  academyId,
  canReverse,
  fresh = false,
  onDone,
}: {
  receipt: Receipt;
  academyId: string;
  canReverse: boolean;
  fresh?: boolean;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const act = useFeesActions(academyId);
  const [r, setR] = useState(initial);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const time = formatClock(
    `${String(Math.floor(r.localMinute / 60)).padStart(2, '0')}:${String(r.localMinute % 60).padStart(2, '0')}`,
    lang,
  );
  const line = (l: Receipt['lines'][number]) =>
    [l.description, l.period ? monthLabel(l.period, lang) : null].filter(Boolean).join(' · ');

  const print = () =>
    printReceipt(r, lang, {
      title: t('fees.receipt.title'),
      number: t('fees.receipt.number'),
      date: t('fees.receipt.date'),
      student: t('fees.receipt.student'),
      code: t('fees.receipt.code'),
      collector: t('fees.receipt.collector'),
      method: t('fees.collect.method'),
      methodName: t(`fees.method.${r.method}`),
      paidFor: t('fees.receipt.paidFor'),
      total: t('fees.receipt.total'),
      balanceAfter: t('fees.receipt.balanceAfter'),
      reversed: t('fees.receipt.reversedStamp'),
      note: t('fees.collect.note'),
      lineLabel: line,
      footer: t('fees.receipt.footer'),
    });

  return (
    <div>
      {fresh && !r.reversed && (
        <div
          className="mb-4 flex items-center gap-3 rounded-2xl border-2 border-emerald-500/60 bg-emerald-500/10 p-4"
          role="status"
        >
          <span className="material-symbols-outlined text-5xl" aria-hidden>
            check_circle
          </span>
          <div>
            <p className="text-xl font-extrabold">{t('fees.receipt.received')}</p>
            <p className="text-sm">
              <Money cents={r.amountCents} currency={r.currency} className="font-bold" /> ·{' '}
              {t(`fees.method.${r.method}`)}
            </p>
          </div>
        </div>
      )}
      {r.reversed && (
        <p
          className="mb-3 rounded-xl border-2 border-error/50 bg-error-container/40 p-3 text-sm font-semibold"
          role="status"
        >
          {t('fees.receipt.reversedNote', { reason: r.reversed.reason ?? '', by: r.reversed.by })}
        </p>
      )}
      <div className="rounded-2xl border border-outline-variant/60 p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-bold">
            <bdi>{r.academy.name}</bdi>
          </p>
          <p className="font-mono text-sm font-bold" dir="ltr">
            {r.receiptNumber}
          </p>
        </div>
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-on-surface-variant">{t('fees.receipt.date')}</dt>
          <dd>
            {dayLabel(r.localDate, lang)} · <span className="tabular-nums">{time}</span>
          </dd>
          <dt className="text-on-surface-variant">{t('fees.receipt.student')}</dt>
          <dd className="font-semibold [overflow-wrap:anywhere]">
            <bdi>{r.student.fullName}</bdi>{' '}
            <span className="font-mono text-xs text-on-surface-variant" dir="ltr">
              {r.student.code}
            </span>
          </dd>
          <dt className="text-on-surface-variant">{t('fees.receipt.collector')}</dt>
          <dd>
            <bdi>{r.collector}</bdi>
          </dd>
          <dt className="text-on-surface-variant">{t('fees.collect.method')}</dt>
          <dd>{t(`fees.method.${r.method}`)}</dd>
        </dl>
        <ul className="mb-2 divide-y divide-outline-variant/40 text-sm">
          {r.lines.map((l, i) => (
            <li key={i} className="flex justify-between gap-3 py-1.5">
              <bdi className="min-w-0">{line(l)}</bdi>
              <Money cents={l.amountCents} currency={r.currency} className="shrink-0" />
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t-2 border-on-surface pt-2 text-lg font-extrabold">
          <span>{t('fees.receipt.total')}</span>
          <Money cents={r.amountCents} currency={r.currency} />
        </p>
        <p className="mt-1 flex justify-between text-sm text-on-surface-variant">
          <span>{t('fees.receipt.balanceAfter')}</span>
          <Money cents={r.balanceAfterCents} currency={r.currency} />
        </p>
      </div>

      {reversing ? (
        <div className="mt-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('fees.reverse.reason')}
            </span>
            <input
              className="input min-h-11"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              maxLength={300}
            />
          </label>
          <p className="mt-1 text-xs text-on-surface-variant">{t('fees.reverse.hint')}</p>
          <ErrorNote error={act.reverse.error} />
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn-ghost min-h-11 px-4"
              onClick={() => setReversing(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn-primary min-h-11 bg-error px-5 text-on-error"
              disabled={reason.trim().length < 3 || act.reverse.isPending}
              aria-busy={act.reverse.isPending}
              onClick={() =>
                act.reverse.mutate(
                  { collectionId: r.collectionId, reason: reason.trim() },
                  {
                    onSuccess: (x) => {
                      setR(x.receipt);
                      setReversing(false);
                    },
                  },
                )
              }
            >
              {t('fees.reverse.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {canReverse && !r.reversed && (
            <button
              type="button"
              className="btn-ghost min-h-11 px-4 text-error"
              onClick={() => setReversing(true)}
            >
              {t('fees.reverse.action')}
            </button>
          )}
          <button type="button" className="btn-secondary min-h-12 px-5" onClick={onDone}>
            {t('fees.receipt.done')}
          </button>
          <button
            type="button"
            className="btn-primary min-h-12 px-5"
            onClick={print}
            autoFocus={fresh}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              print
            </span>
            {t('fees.receipt.print')}
          </button>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Modal, Spinner } from '../../components/ui';
import { errorMessage } from '../../lib/errorMessage';
import { isNetworkFailure } from '../../lib/desk';
import {
  centsToDecimal,
  Charge,
  METHODS,
  Method,
  newRequestKey,
  parseMoney,
  Preview,
  Receipt,
  useFeesActions,
  useStudentFees,
} from '../../lib/centerFees';
import { Money, MoneyInput, monthLabel, dayLabel } from './feeParts';
import { ReceiptView } from './ReceiptView';

/**
 * Taking money from a learner, in three steps: what and how → confirm (the
 * server's own allocation: which charges, how much each, what remains) →
 * the receipt. One request key per confirmation, so a double click, a slow
 * network or a retry after a lost answer can never take the money twice.
 */
export default function CollectDialog({
  academyId,
  academyStudentId,
  canReverse = false,
  onClose,
}: {
  academyId: string;
  academyStudentId: string;
  canReverse?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const fees = useStudentFees(academyId, academyStudentId);
  const act = useFeesActions(academyId);
  const [text, setText] = useState('');
  const [method, setMethod] = useState<Method>('CASH');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const data = fees.data;
  const currency = data?.summary.currency ?? 'EGP';
  const open = useMemo(
    () => (data?.charges ?? []).filter((c) => c.status !== 'VOID' && c.outstandingCents > 0),
    [data],
  );
  const pickedTotal = picked
    ? open.filter((c) => picked.has(c.id)).reduce((s, c) => s + c.outstandingCents, 0)
    : null;
  const amount = picked ? pickedTotal : parseMoney(text);
  const owed = data?.summary.outstandingCents ?? 0;

  const label = (c: Pick<Charge, 'description' | 'period' | 'sessionDate'>) =>
    [
      c.description,
      c.period ? monthLabel(c.period, lang) : c.sessionDate ? dayLabel(c.sessionDate, lang) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const toConfirm = () => {
    if (!amount) return;
    act.preview.mutate(
      {
        academyStudentId,
        amountCents: amount,
        ...(picked
          ? {
              allocations: open
                .filter((c) => picked.has(c.id))
                .map((c) => ({ chargeId: c.id, amountCents: c.outstandingCents })),
            }
          : {}),
      },
      {
        onSuccess: (p) => {
          setPreview(p);
          // A new attempt → a new identity; a retry of THIS attempt keeps it.
          setRequestKey(newRequestKey());
        },
      },
    );
  };

  const confirm = () => {
    if (!preview || !requestKey || act.collect.isPending) return;
    act.collect.mutate(
      {
        academyStudentId,
        requestKey,
        amountCents: preview.amountCents,
        method,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(picked
          ? {
              allocations: preview.allocations.map((a) => ({
                chargeId: a.chargeId,
                amountCents: a.amountCents,
              })),
            }
          : {}),
      },
      { onSuccess: (r) => setReceipt(r.receipt) },
    );
  };

  const title = receipt
    ? t('fees.collect.doneTitle')
    : preview
      ? t('fees.collect.confirmTitle')
      : t('fees.collect.title');
  return (
    <Modal open title={title} onClose={onClose}>
      {!data ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : receipt ? (
        <ReceiptView
          receipt={receipt}
          academyId={academyId}
          canReverse={canReverse}
          fresh
          onDone={onClose}
        />
      ) : preview ? (
        <div>
          <div className="mb-4 rounded-2xl bg-surface-container-low p-4">
            <p className="text-sm text-on-surface-variant">{t('fees.collect.from')}</p>
            <p className="text-lg font-bold [overflow-wrap:anywhere]">
              <bdi>{preview.student.fullName}</bdi>{' '}
              <span className="font-mono text-sm text-on-surface-variant" dir="ltr">
                {preview.student.code}
              </span>
            </p>
            <p className="mt-3 text-sm text-on-surface-variant">{t('fees.collect.amount')}</p>
            <p className="text-3xl font-extrabold">
              <Money cents={preview.amountCents} currency={preview.currency} />
            </p>
            <p className="mt-2 text-sm">
              {t('fees.collect.method')}: <strong>{t(`fees.method.${method}`)}</strong>
            </p>
          </div>
          <p className="mb-2 text-sm font-semibold text-on-surface-variant">
            {t('fees.collect.covers')}
          </p>
          <ul className="mb-3 divide-y divide-outline-variant/40 rounded-xl border border-outline-variant/50">
            {preview.allocations.map((a) => (
              <li
                key={a.chargeId}
                className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
              >
                <span className="min-w-0">
                  <bdi className="font-semibold">
                    {label({ description: a.description, period: a.period, sessionDate: null })}
                  </bdi>
                  <span className="block text-xs text-on-surface-variant">
                    {t('fees.dueOn', { date: dayLabel(a.dueOn, lang) })}
                  </span>
                </span>
                <Money
                  cents={a.amountCents}
                  currency={preview.currency}
                  className="shrink-0 font-bold"
                />
              </li>
            ))}
          </ul>
          <p className="mb-4 flex justify-between text-sm">
            <span className="text-on-surface-variant">{t('fees.collect.remainingAfter')}</span>
            <Money
              cents={preview.balanceAfterCents}
              currency={preview.currency}
              className="font-bold"
            />
          </p>
          {act.collect.error &&
            (isNetworkFailure(act.collect.error) ? (
              <p className="mb-3 rounded-xl bg-amber-500/10 p-3 text-sm" role="alert">
                {t('fees.collect.offline')}
              </p>
            ) : (
              <p className="mb-3 rounded-xl bg-error-container/50 p-3 text-sm" role="alert">
                {errorMessage(act.collect.error)}
              </p>
            ))}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn-ghost min-h-12 px-4"
              disabled={act.collect.isPending}
              onClick={() => {
                setPreview(null);
                act.collect.reset();
              }}
            >
              {t('fees.collect.back')}
            </button>
            <button
              type="button"
              className="btn-primary min-h-12 px-6 text-base font-bold"
              onClick={confirm}
              disabled={act.collect.isPending}
              aria-busy={act.collect.isPending}
              autoFocus
            >
              {act.collect.isPending
                ? t('fees.collect.saving')
                : act.collect.error && isNetworkFailure(act.collect.error)
                  ? t('fees.collect.retry')
                  : t('fees.collect.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            toConfirm();
          }}
        >
          <p className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-bold [overflow-wrap:anywhere]">
              <bdi>{data.student.fullName}</bdi>
            </span>
            <span className="text-sm text-on-surface-variant">
              {t('fees.owed')}:{' '}
              <Money cents={owed} currency={currency} className="font-bold text-on-surface" />
            </span>
          </p>
          {owed === 0 ? (
            <p className="rounded-xl bg-surface-container-low p-4 text-center">
              {t('fees.nothingOwed')}
            </p>
          ) : (
            <>
              {!picked ? (
                <>
                  <MoneyInput
                    label={t('fees.collect.amount')}
                    value={text}
                    onChange={setText}
                    currency={currency}
                    autoFocus
                  />
                  <div className="mb-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary min-h-11 px-3 text-sm"
                      onClick={() => setText(centsToDecimal(owed))}
                    >
                      {t('fees.collect.all')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3 text-sm"
                      onClick={() => setPicked(new Set())}
                    >
                      {t('fees.collect.pick')}
                    </button>
                  </div>
                  <p className="mb-3 text-xs text-on-surface-variant">
                    {t('fees.collect.oldestFirst')}
                  </p>
                </>
              ) : (
                <fieldset className="mb-3">
                  <legend className="mb-1.5 text-sm font-semibold text-on-surface-variant">
                    {t('fees.collect.which')}
                  </legend>
                  <ul className="divide-y divide-outline-variant/40 rounded-xl border border-outline-variant/50">
                    {open.map((c) => (
                      <li key={c.id}>
                        <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-5 w-5"
                            checked={picked.has(c.id)}
                            onChange={() =>
                              setPicked((p) => {
                                const n = new Set(p);
                                if (n.has(c.id)) n.delete(c.id);
                                else n.add(c.id);
                                return n;
                              })
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <bdi className="font-semibold">{label(c)}</bdi>
                            <span className="block text-xs text-on-surface-variant">
                              {t('fees.dueOn', { date: dayLabel(c.dueOn, lang) })}
                            </span>
                          </span>
                          <Money
                            cents={c.outstandingCents}
                            currency={currency}
                            className="shrink-0 font-bold"
                          />
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 flex justify-between text-sm">
                    <span>{t('fees.collect.amount')}</span>
                    <Money cents={pickedTotal ?? 0} currency={currency} className="font-bold" />
                  </p>
                  <button
                    type="button"
                    className="btn-ghost mt-1 min-h-11 px-3 text-sm"
                    onClick={() => setPicked(null)}
                  >
                    {t('fees.collect.typeAmount')}
                  </button>
                </fieldset>
              )}
              <fieldset className="mb-3">
                <legend className="mb-1.5 text-sm font-semibold text-on-surface-variant">
                  {t('fees.collect.method')}
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {METHODS.map((m) => (
                    <label
                      key={m}
                      className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-semibold ${
                        method === m
                          ? 'border-primary bg-primary-fixed/40'
                          : 'border-outline-variant/60'
                      }`}
                    >
                      <input
                        type="radio"
                        name="method"
                        value={m}
                        checked={method === m}
                        onChange={() => setMethod(m)}
                      />
                      {t(`fees.method.${m}`)}
                    </label>
                  ))}
                </div>
                {method === 'CARD_EXTERNAL' && (
                  <p className="mt-1 text-xs text-on-surface-variant">
                    {t('fees.method.cardHint')}
                  </p>
                )}
              </fieldset>
              <label className="mb-4 block">
                <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                  {t('fees.collect.note')}
                </span>
                <input
                  className="input min-h-11"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                />
              </label>
              <ErrorNote error={act.preview.error} />
              <button
                type="submit"
                className="btn-primary min-h-12 w-full text-base font-bold"
                disabled={!amount || act.preview.isPending}
                aria-busy={act.preview.isPending}
              >
                {t('fees.collect.continue')}
              </button>
            </>
          )}
        </form>
      )}
    </Modal>
  );
}

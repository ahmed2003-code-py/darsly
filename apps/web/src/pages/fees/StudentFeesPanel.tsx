import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, ErrorNote, Modal, Skeleton } from '../../components/ui';
import {
  Charge,
  fetchReceipt,
  fetchStatement,
  newRequestKey,
  parseMoney,
  Receipt,
  useFeesAccess,
  useFeesActions,
  usePlans,
  useStudentFees,
} from '../../lib/centerFees';
import CollectDialog from './CollectDialog';
import { ChargeStatusChip, dayLabel, Money, MoneyInput, monthLabel } from './feeParts';
import { printStatement } from './feePrint';
import { ReceiptView } from './ReceiptView';

/**
 * Student 360 — Fees: what this learner owes the center and why, what they
 * paid and the receipts. Collect for those with fees.collect; one-time
 * charges, "this month's fee" and voids with fees.manage; discounts and
 * corrections with fees.adjust; reversals with fees.reverse. Everything here
 * is the center's own money — never the platform's course payments.
 */
export default function StudentFeesPanel({
  academyId,
  academyStudentId,
}: {
  academyId: string;
  academyStudentId: string;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const access = useFeesAccess(academyId);
  const a = access.data;
  const fees = useStudentFees(academyId, academyStudentId, !!a?.canView);
  const [dialog, setDialog] = useState<
    | { kind: 'collect' }
    | { kind: 'oneTime' }
    | { kind: 'monthly' }
    | { kind: 'adjust'; charge: Charge }
    | { kind: 'void'; charge: Charge }
    | { kind: 'receipt'; receipt: Receipt }
    | null
  >(null);
  if (!a?.canView) return null;
  if (fees.isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  const d = fees.data;
  if (!d) return <ErrorNote error={fees.error} />;
  const cur = d.summary.currency;
  const paid = d.charges.reduce((s, c) => s + c.paidCents, 0);
  const label = (c: Charge) =>
    [
      c.description,
      c.period ? monthLabel(c.period, lang) : c.sessionDate ? dayLabel(c.sessionDate, lang) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const statement = async () => {
    const s = await fetchStatement(academyId, academyStudentId);
    const kindLabel = (k: string, label: string, ref?: string) =>
      [
        t(`fees.event.${k}`),
        k === 'COLLECTION' || k === 'REVERSAL'
          ? t(`fees.method.${label}`, { defaultValue: label })
          : label,
        ref,
      ]
        .filter(Boolean)
        .join(' · ');
    printStatement(
      {
        academyName: s.academy.name,
        student: s.student,
        currency: cur,
        outstandingCents: s.summary.outstandingCents,
        rows: s.events.map((e) => ({
          date: e.localDate,
          label: kindLabel(e.kind, e.label, e.ref),
          deltaCents: e.deltaCents,
          balanceCents: e.balanceCents,
        })),
      },
      lang,
      {
        title: t('fees.statement.title'),
        date: t('fees.statement.date'),
        item: t('fees.statement.item'),
        amount: t('fees.statement.amount'),
        balance: t('fees.statement.balance'),
        outstanding: t('fees.owed'),
      },
    );
  };

  return (
    <section aria-label={t('fees.title')}>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label={t('fees.owed')}
          value={<Money cents={d.summary.outstandingCents} currency={cur} />}
          strong
        />
        <Tile
          label={t('fees.overdue')}
          value={<Money cents={d.summary.overdueCents} currency={cur} />}
          warn={d.summary.overdueCents > 0}
        />
        <Tile label={t('fees.paid')} value={<Money cents={paid} currency={cur} />} />
        <Tile
          label={t('fees.nextDue')}
          value={d.summary.nextDue ? dayLabel(d.summary.nextDue.dueOn, lang) : '—'}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {a.canCollect && d.summary.outstandingCents > 0 && (
          <button
            type="button"
            className="btn-primary min-h-12 px-5 font-bold"
            onClick={() => setDialog({ kind: 'collect' })}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              payments
            </span>
            {t('fees.collect.action')}
          </button>
        )}
        {a.canManage && (
          <>
            <button
              type="button"
              className="btn-secondary min-h-11 px-4"
              onClick={() => setDialog({ kind: 'oneTime' })}
            >
              {t('fees.oneTime.action')}
            </button>
            <button
              type="button"
              className="btn-ghost min-h-11 px-4"
              onClick={() => setDialog({ kind: 'monthly' })}
            >
              {t('fees.monthly.action')}
            </button>
          </>
        )}
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={() => void statement()}>
          <span className="material-symbols-outlined text-lg" aria-hidden>
            print
          </span>
          {t('fees.statement.print')}
        </button>
      </div>

      <h3 className="mb-2 text-sm font-bold text-on-surface-variant">{t('fees.charges')}</h3>
      {d.charges.length === 0 ? (
        <EmptyState
          icon="receipt_long"
          title={t('fees.noCharges')}
          hint={t('fees.noChargesHint')}
        />
      ) : (
        <ul className="mb-5 flex flex-col gap-2">
          {[...d.charges].reverse().map((c) => (
            <li key={c.id} className="card p-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold [overflow-wrap:anywhere]">
                    <bdi>{label(c)}</bdi>
                  </p>
                  <p className="text-xs text-on-surface-variant">
                    {t(`fees.kind.${c.kind}`)} ·{' '}
                    {t('fees.dueOn', { date: dayLabel(c.dueOn, lang) })}
                  </p>
                </div>
                <ChargeStatusChip status={c.status} />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <dt className="text-on-surface-variant">{t('fees.due')}</dt>
                  <dd className="font-semibold">
                    <Money cents={c.netCents} currency={cur} />
                  </dd>
                </div>
                <div>
                  <dt className="text-on-surface-variant">{t('fees.paid')}</dt>
                  <dd className="font-semibold">
                    <Money cents={c.paidCents} currency={cur} />
                  </dd>
                </div>
                <div>
                  <dt className="text-on-surface-variant">{t('fees.remaining')}</dt>
                  <dd className="font-bold">
                    <Money cents={c.outstandingCents} currency={cur} />
                  </dd>
                </div>
              </dl>
              {c.adjustments.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-on-surface-variant">
                  {c.adjustments.map((x) => (
                    <li key={x.id}>
                      {t(`fees.adjust.${x.kind}`)}{' '}
                      {x.kind === 'CORRECTION' && (x.deltaCents > 0 ? '+' : '−')}
                      <Money cents={Math.abs(x.deltaCents)} currency={cur} />
                      {x.percentBps ? ` (${x.percentBps / 100}%)` : ''} · <bdi>{x.reason}</bdi>
                    </li>
                  ))}
                </ul>
              )}
              {c.status === 'VOID' && c.voidReason && (
                <p className="mt-1 text-xs text-on-surface-variant">
                  {t('fees.void.done')} · <bdi>{c.voidReason}</bdi>
                </p>
              )}
              {c.status !== 'VOID' && (a.canAdjust || (a.canManage && c.paidCents === 0)) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.canAdjust && (
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3 text-sm"
                      onClick={() => setDialog({ kind: 'adjust', charge: c })}
                    >
                      {t('fees.adjust.action')}
                    </button>
                  )}
                  {a.canManage && c.paidCents === 0 && (
                    <button
                      type="button"
                      className="btn-ghost min-h-11 px-3 text-sm text-error"
                      onClick={() => setDialog({ kind: 'void', charge: c })}
                    >
                      {t('fees.void.action')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-bold text-on-surface-variant">{t('fees.receipts')}</h3>
      {d.collections.length === 0 ? (
        <p className="text-sm text-outline">{t('fees.noReceipts')}</p>
      ) : (
        <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
          {d.collections.map((k) => (
            <li key={k.id}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-start hover:bg-surface-container-low"
                onClick={async () =>
                  setDialog({ kind: 'receipt', receipt: await fetchReceipt(academyId, k.id) })
                }
              >
                <span className="font-mono text-sm font-bold" dir="ltr">
                  {k.receiptNumber}
                </span>
                <span className="min-w-0 flex-1 text-xs text-on-surface-variant">
                  {dayLabel(k.localDate, lang)} · {t(`fees.method.${k.method}`)}
                </span>
                {k.reversedAt && (
                  <span className="text-xs font-bold text-error">
                    {t('fees.receipt.reversedShort')}
                  </span>
                )}
                <Money
                  cents={k.amountCents}
                  currency={k.currency}
                  className={`font-bold ${k.reversedAt ? 'line-through opacity-60' : ''}`}
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {dialog?.kind === 'collect' && (
        <CollectDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          canReverse={a.canReverse}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'receipt' && (
        <Modal open title={t('fees.receipt.title')} onClose={() => setDialog(null)}>
          <ReceiptView
            receipt={dialog.receipt}
            academyId={academyId}
            canReverse={a.canReverse}
            onDone={() => setDialog(null)}
          />
        </Modal>
      )}
      {dialog?.kind === 'oneTime' && (
        <OneTimeDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          currency={cur}
          today={d.summary.today}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'monthly' && (
        <MonthlyDialog
          academyId={academyId}
          academyStudentId={academyStudentId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'adjust' && (
        <AdjustDialog
          academyId={academyId}
          charge={dialog.charge}
          currency={cur}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'void' && (
        <VoidDialog academyId={academyId} charge={dialog.charge} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  strong,
  warn,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <div className={`card p-3 ${warn ? 'border-2 border-amber-500/50' : ''}`}>
      <p className="text-xs text-on-surface-variant">{label}</p>
      <p
        className={`${strong ? 'text-lg font-extrabold sm:text-xl' : 'text-base font-bold'} overflow-hidden text-ellipsis`}
      >
        {value}
      </p>
    </div>
  );
}

function OneTimeDialog({
  academyId,
  academyStudentId,
  currency,
  today,
  onClose,
}: {
  academyId: string;
  academyStudentId: string;
  currency: string;
  today: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFeesActions(academyId);
  const [requestKey] = useState(newRequestKey);
  const [description, setDescription] = useState('');
  const [text, setText] = useState('');
  const [dueOn, setDueOn] = useState(today);
  const cents = parseMoney(text);
  return (
    <Modal open title={t('fees.oneTime.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!cents || !description.trim() || act.oneTime.isPending) return;
          act.oneTime.mutate(
            {
              academyStudentId,
              requestKey,
              description: description.trim(),
              amountCents: cents,
              dueOn,
            },
            { onSuccess: onClose },
          );
        }}
      >
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('fees.oneTime.what')}
          </span>
          <input
            className="input min-h-11"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={120}
            autoFocus
            placeholder={t('fees.oneTime.whatPh')}
          />
        </label>
        <MoneyInput
          label={t('fees.oneTime.amount')}
          value={text}
          onChange={setText}
          currency={currency}
        />
        <label className="mb-4 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('fees.oneTime.dueOn')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            required
          />
        </label>
        <ErrorNote error={act.oneTime.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!cents || !description.trim() || act.oneTime.isPending}
          aria-busy={act.oneTime.isPending}
        >
          {t('fees.oneTime.save')}
        </button>
      </form>
    </Modal>
  );
}

function MonthlyDialog({
  academyId,
  academyStudentId,
  onClose,
}: {
  academyId: string;
  academyStudentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const plans = usePlans(academyId);
  const act = useFeesActions(academyId);
  const monthly = (plans.data ?? []).filter((p) => p.type === 'MONTHLY' && p.status === 'ACTIVE');
  const [planId, setPlanId] = useState('');
  const [posted, setPosted] = useState<number | null>(null);
  return (
    <Modal open title={t('fees.monthly.title')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">{t('fees.monthly.hint')}</p>
      {posted != null ? (
        <>
          <p className="mb-4 rounded-xl bg-surface-container-low p-3 font-semibold" role="status">
            {posted ? t('fees.monthly.posted') : t('fees.monthly.already')}
          </p>
          <button type="button" className="btn-primary min-h-11 w-full" onClick={onClose}>
            {t('fees.receipt.done')}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!planId) return;
            act.monthly.mutate(
              { academyStudentId, planId },
              { onSuccess: (r) => setPosted(r.posted) },
            );
          }}
        >
          <select
            className="input mb-3 min-h-11"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            required
            autoFocus
          >
            <option value="">{t('fees.monthly.pick')}</option>
            {monthly.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.group.name}
              </option>
            ))}
          </select>
          <ErrorNote error={act.monthly.error} />
          <button
            type="submit"
            className="btn-primary mt-2 min-h-12 w-full"
            disabled={!planId || act.monthly.isPending}
          >
            {t('fees.monthly.save')}
          </button>
        </form>
      )}
    </Modal>
  );
}

function AdjustDialog({
  academyId,
  charge,
  currency,
  onClose,
}: {
  academyId: string;
  charge: Charge;
  currency: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFeesActions(academyId);
  const [requestKey] = useState(newRequestKey);
  const [kind, setKind] = useState<'DISCOUNT' | 'CORRECTION'>('DISCOUNT');
  const [mode, setMode] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [direction, setDirection] = useState<'INCREASE' | 'DECREASE'>('DECREASE');
  const [text, setText] = useState('');
  const [pct, setPct] = useState('');
  const [reason, setReason] = useState('');
  const cents = parseMoney(text);
  const bps = /^\d{1,3}(\.\d{1,2})?$/.test(pct) ? Math.round(Number(pct) * 100) : null;
  const ok =
    reason.trim().length >= 3 &&
    (kind === 'DISCOUNT' && mode === 'PERCENT' ? !!bps && bps <= 10_000 : !!cents);
  return (
    <Modal open title={t('fees.adjust.title')} onClose={onClose}>
      <p className="mb-3 text-sm">
        <bdi className="font-semibold">{charge.description}</bdi> · {t('fees.remaining')}{' '}
        <Money cents={charge.outstandingCents} currency={currency} className="font-bold" />
      </p>
      <div
        className="mb-3 grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label={t('fees.adjust.kind')}
      >
        {(['DISCOUNT', 'CORRECTION'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`min-h-11 rounded-xl border px-3 text-sm font-semibold ${kind === k ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
          >
            {t(`fees.adjust.${k}`)}
          </button>
        ))}
      </div>
      {kind === 'DISCOUNT' ? (
        <div className="mb-3 flex gap-2">
          {(['AMOUNT', 'PERCENT'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`min-h-11 flex-1 rounded-xl border px-3 text-sm ${mode === m ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
            >
              {t(`fees.adjust.mode.${m}`)}
            </button>
          ))}
        </div>
      ) : (
        <div className="mb-3 flex gap-2">
          {(['DECREASE', 'INCREASE'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => setDirection(d)}
              className={`min-h-11 flex-1 rounded-xl border px-3 text-sm ${direction === d ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
            >
              {t(`fees.adjust.${d}`)}
            </button>
          ))}
        </div>
      )}
      {kind === 'DISCOUNT' && mode === 'PERCENT' ? (
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('fees.adjust.percent')}
          </span>
          <input
            className="input min-h-11"
            inputMode="decimal"
            dir="ltr"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
          />
        </label>
      ) : (
        <MoneyInput
          label={t('fees.adjust.amount')}
          value={text}
          onChange={setText}
          currency={currency}
        />
      )}
      <label className="mb-3 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
          {t('fees.adjust.reason')}
        </span>
        <input
          className="input min-h-11"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          placeholder={t('fees.adjust.reasonPh')}
        />
      </label>
      <ErrorNote error={act.adjust.error} />
      <button
        type="button"
        className="btn-primary mt-2 min-h-12 w-full"
        disabled={!ok || act.adjust.isPending}
        aria-busy={act.adjust.isPending}
        onClick={() =>
          act.adjust.mutate(
            {
              chargeId: charge.id,
              requestKey,
              kind,
              reason: reason.trim(),
              ...(kind === 'DISCOUNT' && mode === 'PERCENT'
                ? { percentBps: bps! }
                : { amountCents: cents! }),
              ...(kind === 'CORRECTION' ? { direction } : {}),
            },
            { onSuccess: onClose },
          )
        }
      >
        {t('fees.adjust.save')}
      </button>
    </Modal>
  );
}

function VoidDialog({
  academyId,
  charge,
  onClose,
}: {
  academyId: string;
  charge: Charge;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useFeesActions(academyId);
  const [reason, setReason] = useState('');
  return (
    <Modal open title={t('fees.void.title')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">
        {t('fees.void.body', { what: charge.description })}
      </p>
      <label className="mb-3 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
          {t('fees.adjust.reason')}
        </span>
        <input
          className="input min-h-11"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          autoFocus
        />
      </label>
      <ErrorNote error={act.voidCharge.error} />
      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn-primary min-h-11 bg-error px-5 text-on-error"
          disabled={reason.trim().length < 3 || act.voidCharge.isPending}
          onClick={() =>
            act.voidCharge.mutate(
              { chargeId: charge.id, reason: reason.trim() },
              { onSuccess: onClose },
            )
          }
        >
          {t('fees.void.confirm')}
        </button>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { EmptyState, ErrorNote, Modal, Spinner } from '../../components/ui';
import { newRequestKey, parseMoney } from '../../lib/centerFees';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import { isNetworkFailure } from '../../lib/desk';
import {
  downloadStatement,
  Settlement,
  useSettlement,
  useSettlementAccess,
  useSettlementActions,
} from '../../lib/settlements';
import { dayLabel, Money, MoneyInput } from '../fees/feeParts';
import { Lines } from './SettlementsPage';

/**
 * One teacher settlement (C8): frozen lines, adjustments, payments and what
 * changed in the sources since it was finalized. Payments only record that
 * the center paid; Darsly never moves this money.
 */
export default function SettlementPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useSettlementAccess(academyId);
  const q = useSettlement(access.data?.canView ? academyId : undefined, id);
  const [dialog, setDialog] = useState<'pay' | 'adjust' | 'void' | null>(null);
  const a = access.data;
  if (!academyId || access.isLoading || (a?.canView && q.isLoading))
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled || !a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('settle.noAccess')} hint={t('settle.noAccessHint')} />
      </div>
    );
  if (q.error || !q.data)
    return (
      <div className="page">
        <ErrorNote error={q.error} />
      </div>
    );
  const s = q.data;
  const live = s.status !== 'VOID';
  const exportCsv = async () => {
    const { blob, filename } = await downloadStatement(academyId, s.id);
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = filename;
    el.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="page max-w-5xl">
      <Link
        to={`/center/settlements?academy=${academyId}`}
        className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"
      >
        <span className="material-symbols-outlined text-lg rtl:rotate-180" aria-hidden>
          arrow_back
        </span>
        {t('settle.back')}
      </Link>
      <h1 className="font-heading text-2xl font-extrabold sm:text-3xl">{s.teacherName}</h1>
      <p className="mb-4 text-sm text-on-surface-variant">
        {dayLabel(s.periodFrom, i18n.language)} → {dayLabel(s.periodTo, i18n.language)} ·{' '}
        {t(`settle.status.${s.status}`)} · {t('settle.finalizedBy', { name: s.finalizedByName })}
      </p>
      {s.status === 'VOID' && (
        <p className="mb-4 rounded-xl bg-error-container/50 p-3 text-sm" role="status">
          {t('settle.voided', { reason: s.voidReason ?? '' })}
        </p>
      )}
      <section className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(
          [
            ['gross', s.grossCents],
            ['adjust', s.adjustCents],
            ['payable', s.payableCents],
            ['paid', s.paidCents],
            ['remaining', s.remainingCents],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="min-w-0 rounded-xl bg-surface-container-low p-3">
            <p className="text-xs text-on-surface-variant">{t(`settle.sum.${k}`)}</p>
            <Money cents={v} currency={s.currency} className="block font-extrabold" />
          </div>
        ))}
      </section>
      {s.drift && live && (
        <section className="mb-4 rounded-xl bg-amber-500/10 p-3 text-sm" role="status">
          <p className="font-semibold">{t('settle.drift.title')}</p>
          <p className="text-on-surface-variant">
            {t('settle.drift.body', {
              added: s.drift.added.length,
              removed: s.drift.removed.length,
              changed: s.drift.changed.length,
            })}{' '}
            <Money cents={s.drift.deltaCents} currency={s.currency} />
          </p>
          <p className="mt-1 text-xs text-on-surface-variant">{t('settle.drift.hint')}</p>
        </section>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {live && a.canPay && s.remainingCents > 0 && (
          <button
            type="button"
            className="btn-primary min-h-11 px-5"
            onClick={() => setDialog('pay')}
          >
            {t('settle.pay.open')}
          </button>
        )}
        {live && a.canManage && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4"
            onClick={() => setDialog('adjust')}
          >
            {t('settle.adjust.open')}
          </button>
        )}
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={() => void exportCsv()}>
          {t('settle.statement')}
        </button>
        {live && a.canFinalize && s.paidCents === 0 && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4 text-error"
            onClick={() => setDialog('void')}
          >
            {t('settle.void.open')}
          </button>
        )}
      </div>
      <Lines lines={s.lines} currency={s.currency} timezone={s.timezone} />
      {s.adjustments.length > 0 && (
        <section className="card mt-4 p-4">
          <h2 className="mb-2 font-heading text-lg font-bold">{t('settle.adjustments')}</h2>
          <ul className="divide-y divide-outline-variant/40 text-sm">
            {s.adjustments.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-semibold">{t(`settle.adjust.kind.${x.kind}`)}</span>
                  <span className="block text-xs text-on-surface-variant">
                    {dayLabel(x.createdAt.slice(0, 10), i18n.language)} · {x.by} · {x.reason}
                  </span>
                </span>
                <Money cents={x.amountCents} currency={s.currency} className="shrink-0 font-bold" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.payments.length > 0 && (
        <section className="card mt-4 p-4">
          <h2 className="mb-2 font-heading text-lg font-bold">{t('settle.payments')}</h2>
          <ul className="divide-y divide-outline-variant/40 text-sm">
            {s.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-semibold">{t(`settle.pay.method.${p.method}`)}</span>
                  <span className="block text-xs text-on-surface-variant">
                    {dayLabel(p.paidAt.slice(0, 10), i18n.language)} · {p.by}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                </span>
                <Money cents={p.amountCents} currency={s.currency} className="shrink-0 font-bold" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialog === 'pay' && (
        <PayDialog academyId={academyId} s={s} onClose={() => setDialog(null)} />
      )}
      {dialog === 'adjust' && (
        <AdjustDialog academyId={academyId} s={s} onClose={() => setDialog(null)} />
      )}
      {dialog === 'void' && (
        <VoidDialog academyId={academyId} s={s} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function PayDialog({
  academyId,
  s,
  onClose,
}: {
  academyId: string;
  s: Settlement;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useSettlementActions(academyId);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'CASH' | 'BANK_TRANSFER' | 'OTHER'>('CASH');
  const [reference, setReference] = useState('');
  const [requestKey] = useState(newRequestKey);
  const cents = parseMoney(amount);
  const ok = !!cents && cents <= s.remainingCents;
  return (
    <Modal open title={t('settle.pay.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || act.pay.isPending) return;
          act.pay.mutate(
            {
              id: s.id,
              requestKey,
              amountCents: cents!,
              method,
              ...(reference.trim() ? { reference: reference.trim() } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">
          {t('settle.pay.remaining')}{' '}
          <Money cents={s.remainingCents} currency={s.currency} className="font-bold" />
        </p>
        <MoneyInput
          label={t('settle.pay.amount')}
          value={amount}
          onChange={setAmount}
          currency={s.currency}
          invalid={!!cents && cents > s.remainingCents}
          autoFocus
        />
        <div className="my-3 grid grid-cols-3 gap-2" role="radiogroup">
          {(['CASH', 'BANK_TRANSFER', 'OTHER'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => setMethod(m)}
              className={`min-h-11 rounded-xl border px-2 text-sm font-semibold ${method === m ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
            >
              {t(`settle.pay.method.${m}`)}
            </button>
          ))}
        </div>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.pay.reference')}
          </span>
          <input
            className="input min-h-11"
            value={reference}
            maxLength={60}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <p className="mb-3 text-xs text-on-surface-variant">{t('settle.pay.note')}</p>
        {act.pay.error != null &&
          (isNetworkFailure(act.pay.error) ? (
            <p className="text-sm text-error">{t('settle.offline')}</p>
          ) : (
            <ErrorNote error={act.pay.error} />
          ))}
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || act.pay.isPending}
          aria-busy={act.pay.isPending}
        >
          {t('settle.pay.save')}
        </button>
      </form>
    </Modal>
  );
}

function AdjustDialog({
  academyId,
  s,
  onClose,
}: {
  academyId: string;
  s: Settlement;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useSettlementActions(academyId);
  const [kind, setKind] = useState<'BONUS' | 'DEDUCTION' | 'CORRECTION'>(
    s.drift ? 'CORRECTION' : 'BONUS',
  );
  const [amount, setAmount] = useState(s.drift ? String(Math.abs(s.drift.deltaCents) / 100) : '');
  const [negative, setNegative] = useState(!!s.drift && s.drift.deltaCents < 0);
  const [reason, setReason] = useState('');
  const [requestKey] = useState(newRequestKey);
  const cents = parseMoney(amount);
  const signed =
    cents == null
      ? null
      : kind === 'BONUS'
        ? cents
        : kind === 'DEDUCTION'
          ? -cents
          : negative
            ? -cents
            : cents;
  const ok = signed != null && reason.trim().length >= 3;
  return (
    <Modal open title={t('settle.adjust.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || act.adjust.isPending) return;
          act.adjust.mutate(
            { id: s.id, requestKey, kind, amountCents: signed!, reason: reason.trim() },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="mb-3 grid grid-cols-3 gap-2" role="radiogroup">
          {(['BONUS', 'DEDUCTION', 'CORRECTION'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-11 rounded-xl border px-2 text-sm font-semibold ${kind === k ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'}`}
            >
              {t(`settle.adjust.kind.${k}`)}
            </button>
          ))}
        </div>
        <MoneyInput
          label={t('settle.adjust.amount')}
          value={amount}
          onChange={setAmount}
          currency={s.currency}
        />
        {kind === 'CORRECTION' && (
          <label className="my-2 flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5"
              checked={negative}
              onChange={(e) => setNegative(e.target.checked)}
            />
            {t('settle.adjust.reduce')}
          </label>
        )}
        <label className="my-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.adjust.reason')}
          </span>
          <textarea
            className="input min-h-20"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </label>
        <ErrorNote error={act.adjust.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || act.adjust.isPending}
        >
          {t('settle.adjust.save')}
        </button>
      </form>
    </Modal>
  );
}

function VoidDialog({
  academyId,
  s,
  onClose,
}: {
  academyId: string;
  s: Settlement;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = useSettlementActions(academyId);
  const [reason, setReason] = useState('');
  return (
    <Modal open title={t('settle.void.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3 || act.voidSettlement.isPending) return;
          act.voidSettlement.mutate({ id: s.id, reason: reason.trim() }, { onSuccess: onClose });
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">{t('settle.void.body')}</p>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('settle.void.reason')}
          </span>
          <textarea
            className="input min-h-20"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </label>
        <ErrorNote error={act.voidSettlement.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full !bg-error !text-on-error"
          disabled={reason.trim().length < 3 || act.voidSettlement.isPending}
        >
          {t('settle.void.do')}
        </button>
      </form>
    </Modal>
  );
}

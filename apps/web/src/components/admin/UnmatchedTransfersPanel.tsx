import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { egp } from '../../lib/format';
import { paymentMethodLabel } from '../../lib/paymentMethods';
import { Badge, EmptyState, ErrorNote, Field, Modal, Spinner } from '../ui';
import TransferEventNote from './TransferEventNote';

type Filter = 'OPEN' | 'RETURNED' | 'MATCHED' | 'ALL';
const RETURN_METHODS = ['VODAFONE_CASH', 'INSTAPAY', 'BANK_TRANSFER'] as const;

type Choice =
  | { kind: 'payment'; id: string; row: any }
  | { kind: 'purchase'; id: string; row: any }
  | { kind: 'topup'; id: string; row: any }
  | { kind: 'verified'; id: string; row: any };

/**
 * Money that reached Darsly and matched nothing — and the three things finance
 * can do with it. Every action is re-checked by the server (the transfer is
 * still unclaimed, the amount is exact, the target is eligible); the screen
 * only chooses, and says plainly what will happen before it happens.
 */
export default function UnmatchedTransfersPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [deciding, setDeciding] = useState<any | null>(null);
  const [returning, setReturning] = useState<any | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const busy = useRef(false);

  const events = useQuery({
    queryKey: ['admin-transfers', filter],
    queryFn: async () =>
      (await api.get('/admin/payment-events', { params: filter === 'ALL' ? {} : { status: filter } })).data,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin-transfers'] });
    qc.invalidateQueries({ queryKey: ['admin-live-summary'] });
    qc.invalidateQueries({ queryKey: ['admin-live-purchases'] });
    qc.invalidateQueries({ queryKey: ['admin-payments'] });
  };
  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => (await api.post(path, body ?? {})).data,
    onSettled: () => {
      busy.current = false;
      refresh();
    },
  });
  const run = (path: string, body?: unknown) => {
    if (busy.current) return;
    busy.current = true;
    act.mutate({ path, body });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-on-surface-variant">{t('transfers.subtitle')}</p>
      <div className="flex flex-wrap gap-2" role="tablist">
        {(['OPEN', 'RETURNED', 'MATCHED', 'ALL'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              filter === f ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant text-on-surface-variant'
            }`}
            onClick={() => setFilter(f)}
          >
            {t(`transfers.filter.${f}`)}
          </button>
        ))}
      </div>
      <ErrorNote error={act.error} />

      {events.isLoading ? (
        <Spinner />
      ) : !events.data?.length ? (
        <EmptyState icon="task_alt" title={t('transfers.empty')} />
      ) : (
        events.data.map((e: any) => {
          const open = e.status === 'UNMATCHED' || e.status === 'AMBIGUOUS';
          const r = e.transferReturn;
          return (
            <div key={e.id} className="card space-y-2" data-event={e.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-heading text-xl font-bold tabular-nums">{egp(e.amountCents)}</p>
                  <p className="text-sm text-on-surface-variant">
                    {paymentMethodLabel(e.provider)} · {new Date(e.occurredAt).toLocaleString('ar-EG')}
                  </p>
                </div>
                <Badge tone={e.status === 'MATCHED' ? 'teal' : open ? 'warn' : 'neutral'}>
                  {t(`apay.eventStatus.${e.status}`)}
                </Badge>
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                {e.payerName && (
                  <div>
                    <dt className="text-xs text-outline">{t('transfers.payer')}</dt>
                    <dd dir="auto">{e.payerName}</dd>
                  </div>
                )}
                {e.referenceMasked && (
                  <div>
                    <dt className="text-xs text-outline">{t('transfers.reference')}</dt>
                    <dd dir="ltr" className="font-mono" style={{ textAlign: 'start' }}>{e.referenceMasked}</dd>
                  </div>
                )}
                {e.receivingAccount && (
                  <div>
                    <dt className="text-xs text-outline">{t('transfers.intoAccount')}</dt>
                    <dd>{e.receivingAccount.label}</dd>
                  </div>
                )}
              </dl>
              {e.note && <TransferEventNote note={e.note} />}
              {e.matchedPayment?.title && (
                <p className="text-sm">{t('transfers.matchedTo', { title: e.matchedPayment.title })}</p>
              )}

              {open && (
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" onClick={() => setDeciding(e)}>
                    {t('transfers.match')} / {t('transfers.attach')}
                  </button>
                  <button className="btn-ghost" onClick={() => setReturning(e)}>
                    {t('transfers.return')}
                  </button>
                </div>
              )}

              {r && (
                <div className="space-y-2 rounded-xl border border-outline-variant/60 p-3 text-sm">
                  <p className="font-bold">{t(`transfers.returnStatus.${r.status}`)}</p>
                  <p>
                    {t(`method.${r.destinationMethod}`)} · {r.destinationDetails?.holderName} ·{' '}
                    <span dir="ltr" className="select-all font-mono">{r.destinationDetails?.handle}</span>
                  </p>
                  <p className="text-xs text-outline">{r.reason}</p>
                  {r.transferReference && (
                    <p className="text-xs text-outline">{t('adminLive.transferRef', { ref: r.transferReference })}</p>
                  )}
                  {r.status === 'REQUESTED' && (
                    <button
                      className="btn-primary"
                      disabled={act.isPending}
                      onClick={async () =>
                        (await askConfirm(t('transfers.confirmReturn'), { title: t('transfers.approveReturn') })) &&
                        run(`/admin/transfer-returns/${r.id}/approve`)
                      }
                    >
                      {t('transfers.approveReturn')}
                    </button>
                  )}
                  {r.status === 'APPROVED' && (
                    <div className="flex flex-wrap gap-2">
                      <input
                        className="input w-56"
                        dir="ltr"
                        placeholder={t('adminLive.transferRefPh')}
                        aria-label={t('adminLive.transferRefPh')}
                        value={refs[r.id] ?? ''}
                        onChange={(ev) => setRefs((m) => ({ ...m, [r.id]: ev.target.value }))}
                      />
                      <button
                        className="btn-primary"
                        disabled={act.isPending || (refs[r.id] ?? '').trim().length < 3}
                        onClick={async () =>
                          (await askConfirm(t('transfers.confirmComplete', { amount: egp(r.amountCents) }), {
                            title: t('transfers.completeReturn'),
                          })) && run(`/admin/transfer-returns/${r.id}/complete`, { transferReference: refs[r.id] })
                        }
                      >
                        {t('transfers.completeReturn')}
                      </button>
                    </div>
                  )}
                  {(r.status === 'REQUESTED' || r.status === 'APPROVED') && (
                    <CancelReturn
                      pending={act.isPending}
                      onCancel={(reason) => run(`/admin/transfer-returns/${r.id}/cancel`, { reason })}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {deciding && (
        <DecideModal
          event={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            refresh();
          }}
        />
      )}
      {returning && (
        <ReturnModal
          event={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CancelReturn({ pending, onCancel }: { pending: boolean; onCancel: (reason: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open)
    return (
      <button className="text-xs font-bold text-error hover:underline" onClick={() => setOpen(true)}>
        {t('transfers.cancelReturn')}
      </button>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <input
        className="input w-64"
        placeholder={t('transfers.cancelReason')}
        aria-label={t('transfers.cancelReason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        className="btn-ghost text-error"
        disabled={pending || reason.trim().length < 3}
        onClick={async () =>
          (await askConfirm(t('transfers.cancelReturn'), { danger: true })) && onCancel(reason.trim())
        }
      >
        {t('transfers.cancelReturn')}
      </button>
    </div>
  );
}

/** What a transfer would pay for — the same money, three kinds of target. */
function TargetBadge({ target }: { target: 'LIVE' | 'COURSE' | 'WALLET_TOPUP' }) {
  const { t } = useTranslation();
  return (
    <span className="ms-2 rounded-full border border-outline-variant px-2 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">
      {t(`transfers.target.${target}`)}
    </span>
  );
}

/** Choose a pending payment, a Live purchase or a wallet top-up for this transfer, then confirm. */
function DecideModal({ event, onClose, onDone }: { event: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const once = useRef(false);
  const candidates = useQuery({
    queryKey: ['admin-transfer-candidates', event.id],
    queryFn: async () => (await api.get(`/admin/live-commerce/transfers/${event.id}/candidates`)).data,
  });
  const submit = useMutation({
    mutationFn: async () => {
      const body = { reason: reason.trim() };
      if (choice!.kind === 'payment') return (await api.post(`/admin/payment-events/${event.id}/match/${choice!.id}`, body)).data;
      if (choice!.kind === 'topup') return (await api.post(`/admin/payment-events/${event.id}/match-topup/${choice!.id}`, body)).data;
      if (choice!.kind === 'verified') return (await api.post(`/admin/payment-events/${event.id}/link/${choice!.id}`, body)).data;
      return (await api.post(`/admin/live-commerce/transfers/${event.id}/attach/${choice!.id}`, body)).data;
    },
    onSuccess: onDone,
    onSettled: () => {
      once.current = false;
    },
  });
  const payments: any[] = candidates.data?.payments ?? [];
  const purchases: any[] = candidates.data?.purchases ?? [];
  const verified: any[] = candidates.data?.verified ?? [];
  const topups: any[] = candidates.data?.topups ?? [];
  const row = choice?.row;

  return (
    <Modal open onClose={onClose} title={t('transfers.candidatesTitle')} wide>
      <div className="mb-3 flex items-center justify-between rounded-xl bg-surface-container-low p-3 text-sm">
        <span>{t('transfers.incoming')}</span>
        <span className="font-heading text-lg font-bold tabular-nums">{egp(event.amountCents)}</span>
      </div>
      {candidates.isLoading ? (
        <Spinner />
      ) : !confirming ? (
        <div className="space-y-4">
          {!payments.length && !purchases.length && !verified.length && !topups.length && (
            <p className="text-sm text-outline">{t('transfers.noCandidates')}</p>
          )}
          {!!payments.length && (
            <fieldset>
              <legend className="mb-2 text-sm font-bold">{t('transfers.paymentsHeading')}</legend>
              <div className="space-y-2">
                {payments.map((p) => (
                  <label key={p.paymentId} className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${choice?.id === p.paymentId ? 'border-primary' : 'border-outline-variant/60'}`}>
                    <input
                      type="radio"
                      name="transfer-target"
                      className="mt-1 accent-primary"
                      checked={choice?.id === p.paymentId}
                      onChange={() => setChoice({ kind: 'payment', id: p.paymentId, row: p })}
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">
                        {p.title ?? '—'}
                        <TargetBadge target={p.kind === 'live' ? 'LIVE' : 'COURSE'} />
                      </span>
                      <span className="block text-on-surface-variant">
                        {p.buyerName ?? '—'} · {t('transfers.expected')}: {egp(p.expectedCents)}
                      </span>
                      <span className="block text-xs text-outline">
                        {p.transferSource === 'WALLET' && p.referenceMasked
                          ? t('apay.fromWallet', { number: p.referenceMasked })
                          : p.transferSource === 'BANK'
                            ? t('apay.fromBank', { name: p.payerName ?? '—' })
                            : t('apay.noSource')}
                        {' · '}
                        {p.claimed ? t('apay.claimed') : t('apay.notClaimed')}
                        {' · '}
                        {p.hasProof ? t('apay.proofYes') : t('apay.proofNo')}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!!purchases.length && (
            <fieldset>
              <legend className="mb-2 text-sm font-bold">{t('transfers.purchasesHeading')}</legend>
              <div className="space-y-2">
                {purchases.map((p) => (
                  <label key={p.purchaseId} className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${choice?.id === p.purchaseId ? 'border-primary' : 'border-outline-variant/60'}`}>
                    <input
                      type="radio"
                      name="transfer-target"
                      className="mt-1 accent-primary"
                      checked={choice?.id === p.purchaseId}
                      onChange={() => setChoice({ kind: 'purchase', id: p.purchaseId, row: p })}
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">
                        {p.session.title}
                        <TargetBadge target="LIVE" />
                      </span>
                      <span className="block text-on-surface-variant">
                        {p.buyerName ?? '—'}
                        {p.guest && ` (${t('transfers.guest')})`} · {new Date(p.session.startsAt).toLocaleString('ar-EG')}
                      </span>
                      <span className="block text-xs text-outline">
                        {t(`adminLive.status.${p.status}`)} · {t('transfers.expected')}: {egp(p.studentPaysCents)}
                      </span>
                      {p.session.over && <span className="block text-xs text-error">{t('transfers.classOver')}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!!topups.length && (
            <fieldset>
              <legend className="mb-2 text-sm font-bold">{t('transfers.topupsHeading')}</legend>
              <div className="space-y-2">
                {topups.map((p) => (
                  <label key={p.topupId} className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${choice?.id === p.topupId ? 'border-primary' : 'border-outline-variant/60'}`}>
                    <input
                      type="radio"
                      name="transfer-target"
                      className="mt-1 accent-primary"
                      checked={choice?.id === p.topupId}
                      onChange={() => setChoice({ kind: 'topup', id: p.topupId, row: p })}
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">
                        {t('transfers.topupTitle')}
                        <TargetBadge target="WALLET_TOPUP" />
                      </span>
                      <span className="block text-on-surface-variant">
                        {p.buyerName ?? '—'} · {t('transfers.expected')}: {egp(p.expectedCents)}
                      </span>
                      <span className="block text-xs text-outline">
                        {p.transferSource === 'WALLET' && p.referenceMasked
                          ? t('apay.fromWallet', { number: p.referenceMasked })
                          : p.transferSource === 'BANK'
                            ? t('apay.fromBank', { name: p.payerName ?? '—' })
                            : t('apay.noSource')}
                        {' · '}
                        {p.claimed ? t('apay.claimed') : t('apay.notClaimed')}
                        {' · '}
                        {p.hasProof ? t('apay.proofYes') : t('apay.proofNo')}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {!!verified.length && (
            <fieldset>
              <legend className="mb-1 text-sm font-bold">{t('transfers.verifiedHeading')}</legend>
              <p className="mb-2 text-xs text-outline">{t('transfers.verifiedHint')}</p>
              <div className="space-y-2">
                {verified.map((p) => (
                  <label key={p.paymentId} className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${choice?.id === p.paymentId ? 'border-primary' : 'border-outline-variant/60'}`}>
                    <input
                      type="radio"
                      name="transfer-target"
                      className="mt-1 accent-primary"
                      checked={choice?.id === p.paymentId}
                      onChange={() => setChoice({ kind: 'verified', id: p.paymentId, row: p })}
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">{p.title ?? '—'}</span>
                      <span className="block text-on-surface-variant">
                        {p.buyerName ?? '—'} · {egp(p.amountCents)} · {paymentMethodLabel(p.method)}
                      </span>
                      {p.paidAt && (
                        <span className="block text-xs text-outline">
                          {t('transfers.confirmedAt', { time: new Date(p.paidAt).toLocaleString('ar-EG') })}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label={t('transfers.reason')} id="transfer-reason">
            <input id="transfer-reason" className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <button className="btn-primary w-full" disabled={!choice || reason.trim().length < 3} onClick={() => setConfirming(true)}>
            {t('common.next')}
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-2 gap-2 rounded-xl border border-outline-variant/60 p-3">
            <dt className="text-outline">{t('transfers.buyer')}</dt>
            <dd>{row?.buyerName ?? '—'}</dd>
            <dt className="text-outline">{t('apay.item')}</dt>
            <dd>
              {choice!.kind === 'purchase'
                ? row?.session.title
                : choice!.kind === 'topup'
                  ? t('transfers.topupTitle')
                  : (row?.title ?? '—')}
            </dd>
            <dt className="text-outline">{t('transfers.expected')}</dt>
            <dd className="tabular-nums">
              {egp(choice!.kind === 'payment' || choice!.kind === 'topup' ? row?.expectedCents : choice!.kind === 'verified' ? row?.amountCents : row?.studentPaysCents)}
            </dd>
            <dt className="text-outline">{t('transfers.incoming')}</dt>
            <dd className="tabular-nums">{egp(event.amountCents)}</dd>
            <dt className="text-outline">{t('transfers.payer')}</dt>
            <dd dir="auto">{event.payerName ?? '—'}</dd>
            <dt className="text-outline">{t('transfers.state')}</dt>
            <dd>
              {choice!.kind === 'payment' || choice!.kind === 'topup'
                ? row?.claimed
                  ? t('apay.claimed')
                  : t('apay.notClaimed')
                : choice!.kind === 'verified'
                  ? t('transfers.alreadyConfirmed')
                  : t(`adminLive.status.${row?.status}`)}
            </dd>
          </dl>
          {choice!.kind === 'purchase' && row?.session.over && <p className="text-error">{t('transfers.classOver')}</p>}
          <p className="rounded-xl bg-error-container/50 p-3 text-on-error-container">
            {choice!.kind === 'topup'
              ? t('transfers.confirmTopup')
              : choice!.kind === 'payment'
              ? t('transfers.confirmMatch')
              : choice!.kind === 'verified'
                ? t('transfers.confirmLink')
                : t('transfers.confirmAttach')}
          </p>
          <ErrorNote error={submit.error} />
          <div className="flex gap-2">
            <button
              className="btn-primary flex-1"
              disabled={submit.isPending}
              aria-busy={submit.isPending || undefined}
              onClick={() => {
                if (once.current) return;
                once.current = true;
                submit.mutate();
              }}
            >
              {submit.isPending ? t('common.saving') : t('transfers.confirmAction')}
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              {t('common.back')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Open a tracked manual return: destination, reason, then an explicit confirmation. */
function ReturnModal({ event, onClose, onDone }: { event: any; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<string>('VODAFONE_CASH');
  const [holderName, setHolderName] = useState('');
  const [handle, setHandle] = useState('');
  const [reason, setReason] = useState('');
  const once = useRef(false);
  const submit = useMutation({
    mutationFn: async () =>
      (await api.post(`/admin/payment-events/${event.id}/return`, { method, holderName: holderName.trim(), handle: handle.trim(), reason: reason.trim() })).data,
    onSuccess: onDone,
    onSettled: () => {
      once.current = false;
    },
  });
  const ok = holderName.trim().length >= 2 && handle.trim().length >= 4 && reason.trim().length >= 3;
  return (
    <Modal open onClose={onClose} title={t('transfers.returnTitle', { amount: egp(event.amountCents) })}>
      <div className="space-y-3">
        <Field label={t('transfers.returnMethod')} id="return-method">
          <select id="return-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {RETURN_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`method.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('transfers.returnHolder')} id="return-holder">
          <input id="return-holder" className="input" dir="auto" maxLength={80} value={holderName} onChange={(e) => setHolderName(e.target.value)} />
        </Field>
        <Field label={t('transfers.returnHandle')} id="return-handle">
          <input id="return-handle" className="input" dir="ltr" maxLength={64} value={handle} onChange={(e) => setHandle(e.target.value)} />
        </Field>
        <Field label={t('transfers.reason')} id="return-reason">
          <input id="return-reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="rounded-xl bg-error-container/50 p-3 text-sm text-on-error-container">{t('transfers.confirmReturn')}</p>
        <ErrorNote error={submit.error} />
        <button
          className="btn-primary w-full"
          disabled={!ok || submit.isPending}
          onClick={async () => {
            if (once.current) return;
            if (!(await askConfirm(t('transfers.confirmReturn'), { title: t('transfers.returnTitle', { amount: egp(event.amountCents) }) }))) return;
            once.current = true;
            submit.mutate();
          }}
        >
          {submit.isPending ? t('common.saving') : t('transfers.return')}
        </button>
      </div>
    </Modal>
  );
}

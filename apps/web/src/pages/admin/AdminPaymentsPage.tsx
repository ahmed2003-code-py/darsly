import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { paymentMethodLabel } from '../../lib/paymentMethods';
import { askConfirm } from '../../lib/confirm';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { Badge, ErrorNote, Field, Modal, PageHeader, Skeleton } from '../../components/ui';
import i18n from '../../i18n';
import TransferEventNote from '../../components/admin/TransferEventNote';
import { Link } from 'react-router-dom';

const EVENT_TONE: Record<string, string> = {
  MATCHED: 'bg-secondary-container text-on-secondary-container',
  UNMATCHED: 'bg-amber-100 text-amber-700',
  AMBIGUOUS: 'bg-amber-100 text-amber-700',
  DUPLICATE: 'bg-surface-container-high text-outline',
};
const EVENT_ICON: Record<string, string> = {
  MATCHED: 'check_circle',
  UNMATCHED: 'help',
  AMBIGUOUS: 'call_split',
  DUPLICATE: 'content_copy',
};

export default function AdminPaymentsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [proof, setProof] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // The payment an admin is about to confirm, shown with its evidence first.
  const [confirming, setConfirming] = useState<any | null>(null);
  const verifying = useRef(false);
  const [form, setForm] = useState({ method: 'INSTAPAY', label: '', handle: '', instructions: '' });

  const { data: payments, isLoading } = useQuery({
    queryKey: ['admin-payments'],
    queryFn: async () => (await api.get('/admin/payments?status=PENDING')).data,
  });
  const { data: accounts } = useQuery({
    queryKey: ['admin-accounts'],
    queryFn: async () => (await api.get('/admin/payment-accounts')).data,
  });
  const { data: events } = useQuery({
    queryKey: ['admin-payment-events'],
    queryFn: async () => (await api.get('/admin/payment-events')).data,
    refetchInterval: 20_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-payments'] });
  };
  const verify = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/payments/${id}/verify`)).data,
    onSuccess: () => {
      setConfirming(null);
      invalidate();
    },
    onSettled: () => {
      verifying.current = false;
    },
  });
  const reject = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/admin/payments/${id}/reject`, { reason: i18n.t('admin.rejectReason') }))
        .data,
    onSuccess: invalidate,
  });

  const addAccount = useMutation({
    mutationFn: async () => (await api.post('/admin/payment-accounts', form)).data,
    onSuccess: () => {
      setAddOpen(false);
      setForm({ method: 'INSTAPAY', label: '', handle: '', instructions: '' });
      qc.invalidateQueries({ queryKey: ['admin-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
    },
  });
  const toggleAccount = useMutation({
    mutationFn: async (a: any) =>
      (await api.patch(`/admin/payment-accounts/${a.id}`, { isActive: !a.isActive })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
    },
  });
  const delAccount = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/payment-accounts/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-accounts'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts'] });
    },
  });

  return (
    <div className="page">
      <PageHeader title={t('apay.title')} subtitle={t('apay.subtitle')} />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        {/* Pending payments */}
        <div>
          <h2 className="mb-3 font-heading text-xl font-extrabold">{t('apay.pending')}</h2>
          {isLoading ? (
            <Skeleton className="h-40 rounded-2xl" />
          ) : !payments?.length ? (
            <div className="card py-10 text-center text-outline">{t('apay.noPending')}</div>
          ) : (
            <div className="space-y-3">
              {payments.map((p: any) => (
                <div key={p.id} className="card flex gap-3">
                  {p.proofImageUrl && (
                    <button
                      className="h-20 w-16 shrink-0 overflow-hidden rounded-lg border border-outline-variant/50"
                      onClick={() => setProof(p.proofImageUrl)}
                    >
                      <img src={p.proofImageUrl} alt="" className="h-full w-full object-cover" />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">
                      {p.studentName} ·{' '}
                      <span className="text-sm font-normal text-outline">{p.courseTitle}</span>
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-outline">
                      <span className="font-heading font-extrabold text-primary">
                        {egp(p.amountCents)}
                      </span>
                      <span>{paymentMethodLabel(p.method)}</span>
                      {p.reference && <span dir="ltr">#{p.reference}</span>}
                      {p.livePurchaseId && !p.claimedAt && <Badge tone="neutral">{t('apay.notClaimed')}</Badge>}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="btn-primary px-4 py-1.5 text-sm"
                        disabled={verify.isPending}
                        onClick={() => {
                          verify.reset();
                          setConfirming(p);
                        }}
                      >
                        {t('tpay.verify')}
                      </button>
                      <button
                        className="btn-ghost px-4 py-1.5 text-sm text-error"
                        onClick={() => reject.mutate(p.id)}
                      >
                        {t('tpay.reject')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <ErrorNote error={verify.error && !confirming ? verify.error : null} />
          <Link to="/admin/live-commerce" className="mt-3 inline-block text-sm font-bold text-primary hover:underline">
            {t('apay.transfersLink')}
          </Link>

          {/* Auto-verification events from the notification listener */}
          <h2 className="mb-3 mt-8 flex items-center gap-2 font-heading text-xl font-extrabold">
            <span className="material-symbols-outlined text-primary">bolt</span>
            {t('apay.events')}
          </h2>
          <div className="card p-0">
            {!events?.length ? (
              <p className="py-8 text-center text-sm text-outline">{t('apay.noEvents')}</p>
            ) : (
              <ul className="divide-y divide-outline-variant/40">
                {events.slice(0, 20).map((e: any) => (
                  <li key={e.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <span
                      className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${EVENT_TONE[e.status] ?? 'bg-surface-container-high text-outline'}`}
                    >
                      <span className="material-symbols-outlined text-base">
                        {EVENT_ICON[e.status] ?? 'bolt'}
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      {/* Amount and method wrap rather than truncate: a clipped
                          amount is worse than a second line. The reference is
                          LTR because it is a number, inside an RTL sentence. */}
                      <p className="flex flex-wrap items-center gap-x-1.5">
                        <span className="font-bold">{egp(e.amountCents)}</span>
                        <span className="text-outline">·</span>
                        <span>{paymentMethodLabel(e.provider)}</span>
                        {e.referenceMasked && (
                          <>
                            <span className="text-outline">·</span>
                            <span className="text-outline" dir="ltr">
                              #{e.referenceMasked}
                            </span>
                          </>
                        )}
                      </p>
                      {e.note && <TransferEventNote note={e.note} />}
                    </div>
                    <Badge
                      tone={
                        e.status === 'MATCHED'
                          ? 'teal'
                          : e.status === 'UNMATCHED' || e.status === 'AMBIGUOUS'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {t(`apay.eventStatus.${e.status}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Receiving accounts */}
        <aside>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading text-xl font-extrabold">{t('apay.accounts')}</h2>
            <button className="btn-primary px-3 py-1.5 text-sm" onClick={() => setAddOpen(true)}>
              <span className="material-symbols-outlined text-base">add</span>
              {t('apay.add')}
            </button>
          </div>
          <div className="space-y-2">
            {(accounts ?? []).map((a: any) => (
              <div key={a.id} className="card p-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{a.label}</span>
                  <Badge tone={a.isActive ? 'teal' : 'neutral'}>
                    {a.isActive ? t('apay.active') : t('apay.inactive')}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-sm text-outline" dir="ltr">
                  {a.handle}
                </p>
                <div className="mt-2 flex gap-3 text-xs">
                  <button
                    className="text-primary hover:underline"
                    onClick={() => toggleAccount.mutate(a)}
                  >
                    {a.isActive ? t('apay.disable') : t('apay.enable')}
                  </button>
                  <button
                    className="text-error hover:underline"
                    onClick={async () =>
                      (await askConfirm(t('apay.delConfirm'))) && delAccount.mutate(a.id)
                    }
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <Modal open={!!confirming} onClose={() => setConfirming(null)} title={t('apay.verifyTitle')}>
        {confirming && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border border-outline-variant/60 p-3">
              <dt className="text-outline">{t('apay.buyer')}</dt>
              <dd>{confirming.studentName}</dd>
              <dt className="text-outline">{t('apay.item')}</dt>
              <dd>
                {confirming.courseTitle}
                {confirming.sessionStartsAt && ` · ${new Date(confirming.sessionStartsAt).toLocaleString('ar-EG')}`}
              </dd>
              <dt className="text-outline">{t('apay.expected')}</dt>
              <dd className="font-heading font-bold tabular-nums">
                {egp(confirming.amountCents - (confirming.walletCents ?? 0))}
              </dd>
              <dt className="text-outline">{t('apay.evidence')}</dt>
              <dd className="space-y-0.5">
                <span className="block">{paymentMethodLabel(confirming.method)}</span>
                <span className="block">
                  {confirming.transferSource === 'WALLET' && confirming.reference
                    ? t('apay.fromWallet', { number: confirming.reference })
                    : confirming.transferSource === 'BANK'
                      ? t('apay.fromBank', { name: confirming.payerName ?? '—' })
                      : confirming.reference
                        ? `#${confirming.reference}`
                        : t('apay.noSource')}
                </span>
                <span className="block">{confirming.hasProof ? t('apay.proofYes') : t('apay.proofNo')}</span>
                {confirming.proofSummary?.amountCents != null && (
                  <span className="block">
                    {t('apay.receiptSays', {
                      amount: egp(confirming.proofSummary.amountCents),
                      time: confirming.proofSummary.sentAtText ?? '—',
                    })}
                  </span>
                )}
              </dd>
              <dt className="text-outline">{t('apay.state')}</dt>
              <dd>
                {confirming.livePurchaseStatus
                  ? t(`adminLive.status.${confirming.livePurchaseStatus}`)
                  : t('apay.statePending')}
                {confirming.livePurchaseId && (
                  <span className="block text-xs text-outline">
                    {confirming.claimedAt ? t('apay.claimed') : t('apay.notClaimed')}
                  </span>
                )}
              </dd>
            </dl>
            <p className="rounded-xl bg-error-container/50 p-3 text-on-error-container" role="alert">
              {t('apay.verifyWarning')}
            </p>
            <ErrorNote error={verify.error} />
            <div className="flex gap-2">
              <button
                className="btn-primary flex-1"
                disabled={verify.isPending}
                aria-busy={verify.isPending || undefined}
                onClick={() => {
                  if (verifying.current) return;
                  verifying.current = true;
                  verify.mutate(confirming.id);
                }}
              >
                {verify.isPending ? t('common.saving') : t('apay.verifyConfirm')}
              </button>
              <button className="btn-ghost" onClick={() => setConfirming(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!proof} onClose={() => setProof(null)} title={t('tpay.proof')} wide>
        {proof && <img src={proof} alt="" className="mx-auto max-h-[70vh] rounded-lg" />}
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('apay.addTitle')}>
        <Field label={t('pay.method')}>
          <select
            className="input"
            value={form.method}
            onChange={(e) => setForm({ ...form, method: e.target.value })}
          >
            <option value="INSTAPAY">{t('method.INSTAPAY')}</option>
            <option value="VODAFONE_CASH">{t('method.VODAFONE_CASH')}</option>
            <option value="BANK_TRANSFER">{t('method.BANK_TRANSFER')}</option>
            <option value="OTHER">{t('method.OTHER')}</option>
          </select>
        </Field>
        <Field label={t('apay.label')}>
          <input
            className="input"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder={t('method.INSTAPAY')}
          />
        </Field>
        <Field label={t('apay.handle')}>
          <input
            className="input"
            dir="ltr"
            value={form.handle}
            onChange={(e) => setForm({ ...form, handle: e.target.value })}
            placeholder="darsly@instapay / 010…"
          />
        </Field>
        <Field label={t('apay.instructions')}>
          <input
            className="input"
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </Field>
        <ErrorNote error={addAccount.error} />
        <button
          className="btn-primary mt-2 w-full"
          disabled={addAccount.isPending || !form.label.trim() || !form.handle.trim()}
          onClick={() => addAccount.mutate()}
        >
          {t('common.save')}
        </button>
      </Modal>
    </div>
  );
}

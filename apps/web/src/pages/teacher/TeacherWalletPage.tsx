import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, ErrorNote, Field, Modal, PageHeader, Skeleton } from '../../components/ui';

const PAYOUT_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral' | 'primary'> = {
  COMPLETED: 'teal', REQUESTED: 'warn', APPROVED: 'primary', PROCESSING: 'primary', REJECTED: 'error',
};

export default function TeacherWalletPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState('');
  const [newMethod, setNewMethod] = useState({ method: 'INSTAPAY', details: '' });
  // Phase 7: cash — pending claims to confirm/reject, and recording cash in hand.
  const [cashQueueOpen, setCashQueueOpen] = useState(false);
  const [recordCashOpen, setRecordCashOpen] = useState(false);
  const [recordCash, setRecordCash] = useState({ studentId: '', courseId: '', receiver: 'TEACHER' as 'TEACHER' | 'CENTER', note: '' });

  const { data: wallet, isLoading } = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => (await api.get('/teacher/wallet')).data,
  });
  const { data: methods } = useQuery({
    queryKey: ['payout-methods'],
    queryFn: async () => (await api.get('/teacher/payouts/methods')).data,
  });
  const { data: cashQueue } = useQuery({
    queryKey: ['payments-cash-pending'],
    queryFn: async () => (await api.get('/teacher/payments', { params: { status: 'PENDING', method: 'CASH' } })).data,
    enabled: cashQueueOpen,
  });
  const { data: myCourses } = useQuery({
    queryKey: ['teacher-courses-for-cash'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
    enabled: recordCashOpen,
  });
  const { data: roster } = useQuery({
    queryKey: ['roster-for-cash'],
    queryFn: async () => (await api.get('/teacher/roster', { params: { pageSize: 200 } })).data,
    enabled: recordCashOpen,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['wallet'] });
    queryClient.invalidateQueries({ queryKey: ['payout-methods'] });
  };

  const requestPayout = useMutation({
    mutationFn: async () =>
      (await api.post('/teacher/payouts', { amountCents: Math.round(Number(amount) * 100), methodId })).data,
    onSuccess: () => { invalidate(); setPayoutOpen(false); setAmount(''); },
  });
  const addMethod = useMutation({
    mutationFn: async () =>
      (await api.post('/teacher/payouts/methods', {
        method: newMethod.method,
        details: { info: newMethod.details },
        isDefault: !methods?.length,
      })).data,
    onSuccess: () => { invalidate(); setMethodOpen(false); setNewMethod({ method: 'INSTAPAY', details: '' }); },
  });
  const invalidateCash = () => {
    invalidate();
    queryClient.invalidateQueries({ queryKey: ['payments-cash-pending'] });
  };
  const confirmCash = useMutation({
    mutationFn: async (id: string) => (await api.post(`/teacher/payments/${id}/confirm-cash`)).data,
    onSuccess: invalidateCash,
  });
  const rejectCash = useMutation({
    mutationFn: async (id: string) => (await api.post(`/teacher/payments/${id}/reject-cash`)).data,
    onSuccess: invalidateCash,
  });
  const submitRecordCash = useMutation({
    mutationFn: async () => (await api.post('/teacher/payments/cash', recordCash)).data,
    onSuccess: () => { invalidateCash(); setRecordCashOpen(false); setRecordCash({ studentId: '', courseId: '', receiver: 'TEACHER', note: '' }); },
  });

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton className="mb-6 h-40 w-full rounded-xl" />
        <div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-64 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
      </div>
    );
  }

  const minEgp = (wallet.payoutMinimumCents / 100).toFixed(0);

  return (
    <div className="page">
      <PageHeader
        title={t('wallet.title')}
        subtitle={t('wallet.subtitle')}
        action={
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => setRecordCashOpen(true)}>
              <span className="material-symbols-outlined">payments</span>
              {t('wallet.cash.record')}
            </button>
            <button
              className="btn-primary"
              disabled={!methods?.length || wallet.balanceCents < wallet.payoutMinimumCents}
              onClick={() => { setMethodId(methods?.[0]?.id ?? ''); setPayoutOpen(true); }}
            >
              <span className="material-symbols-outlined">account_balance</span>
              {t('wallet.requestPayout')}
            </button>
          </div>
        }
      />

      {/* Balance + earnings tiles */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card bg-primary text-on-primary">
          <p className="text-sm opacity-90">{t('wallet.balance')}</p>
          <p className="font-heading text-3xl font-extrabold">{egp(wallet.balanceCents)}</p>
          <p className="mt-1 text-xs opacity-80">{t('wallet.minPayout', { amount: `${minEgp} ${t('common.currencyShort')}` })}</p>
        </div>
        <div className="card"><p className="text-sm text-on-surface-variant">{t('wallet.net')}</p><p className="font-heading text-3xl font-extrabold text-accent">{egp(wallet.netCents ?? wallet.earnedHereCents ?? 0)}</p></div>
        <button type="button" className="card text-start transition hover:shadow-md" onClick={() => setCashQueueOpen(true)}>
          <p className="text-sm text-on-surface-variant">{t('wallet.cash.pending')}</p>
          <p className="font-heading text-3xl font-extrabold">{egp(wallet.pendingCashCents ?? 0)}</p>
          {(wallet.pendingCashCount ?? 0) > 0 && <p className="mt-1 text-xs text-warn">{t('wallet.cash.pendingCount', { count: wallet.pendingCashCount })}</p>}
        </button>
        {wallet.kind === 'CENTER' && wallet.scope === 'ORGANISATION' && (
          <div className="card">
            <p className="text-sm text-on-surface-variant">{t('wallet.cash.teacherSharePercent')}</p>
            <p className="font-heading text-3xl font-extrabold">{wallet.teacherSharePercent == null ? '—' : `${wallet.teacherSharePercent}%`}</p>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent sales */}
        <div className="card">
          <h2 className="mb-4 font-heading text-xl font-bold">{t('wallet.recentPayments')}</h2>
          {!wallet.recentPayments.length ? (
            <p className="py-8 text-center text-outline">{t('wallet.noPayments')}</p>
          ) : (
            <ul className="divide-y divide-outline-variant/40">
              {wallet.recentPayments.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <p className="truncate font-bold">{p.courseTitle}</p>
                    <p className="truncate text-xs text-outline">{p.studentName} · {p.invoiceSerial}</p>
                  </div>
                  <div className="text-end">
                    <p className="font-heading font-bold text-accent">{egp(p.amountCents)}</p>
                    <p className="text-xs text-outline">{dateShort(p.paidAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Payout methods + requests */}
        <div className="space-y-6">
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-heading text-xl font-bold">{t('wallet.payoutMethods')}</h2>
              <button className="text-sm font-bold text-primary hover:underline" onClick={() => setMethodOpen(true)}>
                + {t('wallet.addMethod')}
              </button>
            </div>
            {!methods?.length ? (
              <p className="py-4 text-center text-outline">{t('wallet.noMethods')}</p>
            ) : (
              <ul className="space-y-2">
                {methods.map((m: any) => (
                  <li key={m.id} className="flex items-center justify-between rounded-lg bg-surface-container-low px-4 py-2 text-sm">
                    <span className="flex items-center gap-2 font-bold">
                      <span className="material-symbols-outlined text-base text-primary">account_balance_wallet</span>
                      {t(`wallet.${m.method}`)}
                    </span>
                    {m.isDefault && <Badge tone="teal">{t('common.default')}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2 className="mb-3 font-heading text-xl font-bold">{t('wallet.payouts')}</h2>
            {!wallet.payouts.length ? (
              <p className="py-4 text-center text-outline">{t('wallet.noPayouts')}</p>
            ) : (
              <ul className="divide-y divide-outline-variant/40">
                {wallet.payouts.map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between py-3">
                    <div>
                      <p className="font-heading font-bold">{egp(p.amountCents)}</p>
                      <p className="text-xs text-outline">{dateShort(p.createdAt)}</p>
                    </div>
                    <Badge tone={PAYOUT_TONE[p.status] ?? 'neutral'}>{t(`wallet.payoutStatus.${p.status}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Request payout modal */}
      <Modal open={payoutOpen} title={t('wallet.requestPayout')} onClose={() => setPayoutOpen(false)}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); requestPayout.mutate(); }}>
          <Field label={t('wallet.amount')} hint={`${t('wallet.balance')}: ${egp(wallet.balanceCents)}`}>
            <input className="input" inputMode="decimal" required value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Field label={t('wallet.method')}>
            <select className="input py-2.5" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
              {(methods ?? []).map((m: any) => (
                <option key={m.id} value={m.id}>{t(`wallet.${m.method}`)}</option>
              ))}
            </select>
          </Field>
          <button className="btn-primary w-full" disabled={requestPayout.isPending}>{t('wallet.submit')}</button>
          <ErrorNote error={requestPayout.error} />
        </form>
      </Modal>

      {/* Phase 7: pending cash confirmations */}
      <Modal open={cashQueueOpen} title={t('wallet.cash.pending')} onClose={() => setCashQueueOpen(false)} wide>
        {!cashQueue?.length ? (
          <p className="py-8 text-center text-outline">{t('wallet.cash.noneQueued')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {cashQueue.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-bold">{p.courseTitle}</p>
                  <p className="truncate text-xs text-outline">{p.studentName} · {egp(p.amountCents)} · {t(`wallet.cash.origin.${p.cashOrigin}`)}</p>
                  {p.note && <p className="truncate text-xs text-outline">{p.note}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className="btn-primary px-3 py-1.5 text-xs" disabled={confirmCash.isPending} onClick={() => confirmCash.mutate(p.id)}>
                    {t('wallet.cash.confirm')}
                  </button>
                  <button className="btn-secondary px-3 py-1.5 text-xs" disabled={rejectCash.isPending} onClick={() => rejectCash.mutate(p.id)}>
                    {t('wallet.cash.reject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={confirmCash.error ?? rejectCash.error} />
      </Modal>

      {/* Phase 7: record cash received in hand */}
      <Modal open={recordCashOpen} title={t('wallet.cash.record')} onClose={() => setRecordCashOpen(false)}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); submitRecordCash.mutate(); }}>
          <Field label={t('wallet.cash.course')}>
            <select className="input py-2.5" required value={recordCash.courseId} onChange={(e) => setRecordCash({ ...recordCash, courseId: e.target.value })}>
              <option value="">{t('wallet.cash.pickCourse')}</option>
              {(myCourses ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </Field>
          <Field label={t('wallet.cash.student')}>
            <select className="input py-2.5" required value={recordCash.studentId} onChange={(e) => setRecordCash({ ...recordCash, studentId: e.target.value })}>
              <option value="">{t('wallet.cash.pickStudent')}</option>
              {(roster?.students ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </Field>
          {wallet.kind === 'CENTER' && (
            <Field label={t('pay.cash.receiver')}>
              <select className="input py-2.5" value={recordCash.receiver} onChange={(e) => setRecordCash({ ...recordCash, receiver: e.target.value as 'TEACHER' | 'CENTER' })}>
                <option value="TEACHER">{t('pay.cash.receiverTeacher')}</option>
                <option value="CENTER">{t('pay.cash.receiverCenter')}</option>
              </select>
            </Field>
          )}
          <Field label={t('pay.cash.note')}>
            <input className="input" value={recordCash.note} onChange={(e) => setRecordCash({ ...recordCash, note: e.target.value })} maxLength={300} />
          </Field>
          <button className="btn-primary w-full" disabled={submitRecordCash.isPending}>{t('wallet.cash.record')}</button>
          <ErrorNote error={submitRecordCash.error} />
        </form>
      </Modal>

      {/* Add method modal */}
      <Modal open={methodOpen} title={t('wallet.addMethod')} onClose={() => setMethodOpen(false)}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); addMethod.mutate(); }}>
          <Field label={t('wallet.methodType')}>
            <select className="input py-2.5" value={newMethod.method} onChange={(e) => setNewMethod({ ...newMethod, method: e.target.value })}>
              <option value="INSTAPAY">{t('wallet.INSTAPAY')}</option>
              <option value="VODAFONE_CASH">{t('wallet.VODAFONE_CASH')}</option>
              <option value="BANK_TRANSFER">{t('wallet.BANK_TRANSFER')}</option>
            </select>
          </Field>
          <Field label={t('wallet.details')}>
            <input className="input" required placeholder={t('wallet.detailsPlaceholder')} value={newMethod.details}
              onChange={(e) => setNewMethod({ ...newMethod, details: e.target.value })} />
          </Field>
          <button className="btn-primary w-full" disabled={addMethod.isPending}>{t('wallet.addMethod')}</button>
          <ErrorNote error={addMethod.error} />
        </form>
      </Modal>
    </div>
  );
}

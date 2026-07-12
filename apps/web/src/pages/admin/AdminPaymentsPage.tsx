import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { Badge, ErrorNote, Field, Modal, PageHeader, Skeleton } from '../../components/ui';

const METHOD_LABEL: Record<string, string> = {
  INSTAPAY: 'إنستاباي', VODAFONE_CASH: 'فودافون كاش', BANK_TRANSFER: 'تحويل بنكي', OTHER: 'أخرى',
};
const EVENT_TONE: Record<string, string> = {
  MATCHED: 'bg-secondary-container text-on-secondary-container',
  UNMATCHED: 'bg-amber-100 text-amber-700', AMBIGUOUS: 'bg-amber-100 text-amber-700',
  DUPLICATE: 'bg-surface-container-high text-outline',
};
const EVENT_ICON: Record<string, string> = {
  MATCHED: 'check_circle', UNMATCHED: 'help', AMBIGUOUS: 'call_split', DUPLICATE: 'content_copy',
};

export default function AdminPaymentsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [proof, setProof] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
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

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['admin-payments'] }); };
  const verify = useMutation({ mutationFn: async (id: string) => (await api.post(`/admin/payments/${id}/verify`)).data, onSuccess: invalidate });
  const reject = useMutation({ mutationFn: async (id: string) => (await api.post(`/admin/payments/${id}/reject`, { reason: 'رفض من الإدارة' })).data, onSuccess: invalidate });

  const addAccount = useMutation({
    mutationFn: async () => (await api.post('/admin/payment-accounts', form)).data,
    onSuccess: () => { setAddOpen(false); setForm({ method: 'INSTAPAY', label: '', handle: '', instructions: '' }); qc.invalidateQueries({ queryKey: ['admin-accounts'] }); qc.invalidateQueries({ queryKey: ['payment-accounts'] }); },
  });
  const toggleAccount = useMutation({
    mutationFn: async (a: any) => (await api.patch(`/admin/payment-accounts/${a.id}`, { isActive: !a.isActive })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-accounts'] }); qc.invalidateQueries({ queryKey: ['payment-accounts'] }); },
  });
  const delAccount = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/payment-accounts/${id}`)).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-accounts'] }); qc.invalidateQueries({ queryKey: ['payment-accounts'] }); },
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
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
                    <button className="h-20 w-16 shrink-0 overflow-hidden rounded-lg border border-outline-variant/50" onClick={() => setProof(p.proofImageUrl)}>
                      <img src={p.proofImageUrl} alt="" className="h-full w-full object-cover" />
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{p.studentName} · <span className="text-sm font-normal text-outline">{p.courseTitle}</span></p>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-outline">
                      <span className="font-heading font-extrabold text-primary">{egp(p.amountCents)}</span>
                      <span>{METHOD_LABEL[p.method] ?? p.method}</span>
                      {p.reference && <span dir="ltr">#{p.reference}</span>}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button className="btn-primary px-4 py-1.5 text-sm" disabled={verify.isPending} onClick={() => verify.mutate(p.id)}>{t('tpay.verify')}</button>
                      <button className="btn-ghost px-4 py-1.5 text-sm text-error" onClick={() => reject.mutate(p.id)}>{t('tpay.reject')}</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <ErrorNote error={verify.error} />

          {/* Auto-verification events from the notification listener */}
          <h2 className="mb-3 mt-8 flex items-center gap-2 font-heading text-xl font-extrabold">
            <span className="material-symbols-outlined text-primary">bolt</span>{t('apay.events')}
          </h2>
          <div className="card p-0">
            {!events?.length ? (
              <p className="py-8 text-center text-sm text-outline">{t('apay.noEvents')}</p>
            ) : (
              <ul className="divide-y divide-outline-variant/40">
                {events.slice(0, 20).map((e: any) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${EVENT_TONE[e.status] ?? 'bg-surface-container-high text-outline'}`}>
                      <span className="material-symbols-outlined text-base">{EVENT_ICON[e.status] ?? 'bolt'}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate">
                        <span className="font-bold">{egp(e.amountCents)}</span> · {METHOD_LABEL[e.provider] ?? e.provider}
                        {e.reference && <span className="text-outline" dir="ltr"> · #{e.reference}</span>}
                      </p>
                      {e.note && <p className="truncate text-xs text-outline">{e.note}</p>}
                    </div>
                    <Badge tone={e.status === 'MATCHED' ? 'teal' : e.status === 'UNMATCHED' || e.status === 'AMBIGUOUS' ? 'warn' : 'neutral'}>
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
              <span className="material-symbols-outlined text-base">add</span>{t('apay.add')}
            </button>
          </div>
          <div className="space-y-2">
            {(accounts ?? []).map((a: any) => (
              <div key={a.id} className="card p-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{a.label}</span>
                  <Badge tone={a.isActive ? 'teal' : 'neutral'}>{a.isActive ? t('apay.active') : t('apay.inactive')}</Badge>
                </div>
                <p className="mt-1 font-mono text-sm text-outline" dir="ltr">{a.handle}</p>
                <div className="mt-2 flex gap-3 text-xs">
                  <button className="text-primary hover:underline" onClick={() => toggleAccount.mutate(a)}>{a.isActive ? t('apay.disable') : t('apay.enable')}</button>
                  <button className="text-error hover:underline" onClick={() => window.confirm(t('apay.delConfirm')) && delAccount.mutate(a.id)}>{t('common.delete')}</button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <Modal open={!!proof} onClose={() => setProof(null)} title={t('tpay.proof')} wide>
        {proof && <img src={proof} alt="" className="mx-auto max-h-[70vh] rounded-lg" />}
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('apay.addTitle')}>
        <Field label={t('pay.method')}>
          <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            <option value="INSTAPAY">إنستاباي</option><option value="VODAFONE_CASH">فودافون كاش</option>
            <option value="BANK_TRANSFER">تحويل بنكي</option><option value="OTHER">أخرى</option>
          </select>
        </Field>
        <Field label={t('apay.label')}><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="إنستاباي درسلي" /></Field>
        <Field label={t('apay.handle')}><input className="input" dir="ltr" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="darsly@instapay / 010…" /></Field>
        <Field label={t('apay.instructions')}><input className="input" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        <ErrorNote error={addAccount.error} />
        <button className="btn-primary mt-2 w-full" disabled={addAccount.isPending || !form.label.trim() || !form.handle.trim()} onClick={() => addAccount.mutate()}>{t('common.save')}</button>
      </Modal>
    </div>
  );
}

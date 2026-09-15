import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { EmptyState, PageHeader, Spinner } from '../../components/ui';
import { Reveal, Stagger, StaggerItem } from '../../components/motion';
import WalletTopupModal from '../../components/WalletTopupModal';

interface WalletTxn {
  id: string;
  kind: 'TOPUP' | 'PURCHASE' | 'REFUND' | 'ADJUST';
  amountCents: number;
  description: string;
  createdAt: string;
}
interface WalletData {
  balanceCents: number;
  currency: string;
  transactions: WalletTxn[];
  pendingTopups: { id: string; amountCents: number; method: string; createdAt: string }[];
}

const KIND_ICON: Record<string, string> = {
  TOPUP: 'add_card', PURCHASE: 'shopping_cart', REFUND: 'undo', ADJUST: 'tune',
};

export default function WalletPage() {
  const { t } = useTranslation();
  const [topupOpen, setTopupOpen] = useState(false);

  const { data, isLoading } = useQuery<WalletData>({
    queryKey: ['wallet'],
    queryFn: async () => (await api.get('/wallet')).data,
  });

  if (isLoading) return <div className="page"><Spinner /></div>;

  const pending = data?.pendingTopups?.[0];

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('nav.wallet')}
        title={t('walletStudent.title')}
        subtitle={t('walletStudent.subtitle')}
        action={
          <button className="btn-primary" onClick={() => setTopupOpen(true)}>
            <span className="material-symbols-outlined text-[20px]">add_card</span>
            {t('walletStudent.topup')}
          </button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Balance + history */}
        <div className="space-y-6 lg:col-span-2">
          {/* Balance hero */}
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl bg-primary p-6 text-on-primary shadow-card">
              <div className="absolute -end-6 -top-8 h-40 w-40 rounded-full bg-on-primary/10" aria-hidden />
              <div className="absolute -bottom-10 -start-4 h-32 w-32 rounded-full bg-on-primary/10" aria-hidden />
              <p className="relative text-sm font-semibold opacity-90">{t('walletStudent.balance')}</p>
              <p className="relative mt-1 font-heading text-5xl font-extrabold tracking-tight tabular-nums" dir="ltr">
                {egp(data?.balanceCents ?? 0)}
              </p>
              {pending && (
                <p className="relative mt-4 inline-flex items-center gap-2 rounded-full bg-on-primary/15 px-3 py-1.5 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[18px]">hourglass_top</span>
                  {t('walletStudent.pending')} · {egp(pending.amountCents)}
                </p>
              )}
            </div>
          </Reveal>

          {/* History */}
          <section>
            <h2 className="mb-3 font-heading text-xl font-extrabold">{t('walletStudent.history')}</h2>
            {!data?.transactions?.length ? (
              <EmptyState icon="account_balance_wallet" title={t('walletStudent.noHistory')} />
            ) : (
              <Stagger className="space-y-2">
                {data.transactions.map((tx) => {
                  const positive = tx.amountCents >= 0;
                  return (
                    <StaggerItem key={tx.id}>
                      <div className="card flex items-center gap-4 py-3">
                        <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${positive ? 'bg-secondary-container/50 text-secondary' : 'bg-surface-container-high text-on-surface-variant'}`}>
                          <span className="material-symbols-outlined text-[22px]">{KIND_ICON[tx.kind] ?? 'payments'}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-bold">{tx.description}</p>
                          <p className="text-xs text-outline">
                            {t(`walletStudent.kind.${tx.kind}`)} · {dateShort(tx.createdAt)}
                          </p>
                        </div>
                        <span className={`shrink-0 font-heading font-bold tabular-nums ${positive ? 'text-secondary' : 'text-on-surface'}`} dir="ltr">
                          {positive ? '+' : '−'}{egp(Math.abs(tx.amountCents))}
                        </span>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
          </section>
        </div>

        {/* How to top up */}
        <aside>
          <div className="card">
            <h2 className="mb-4 font-heading text-lg font-extrabold">{t('walletStudent.howTitle')}</h2>
            <ol className="space-y-4">
              {['how1', 'how2', 'how3'].map((k, i) => (
                <li key={k} className="flex gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading text-sm font-bold text-on-primary-fixed">
                    {i + 1}
                  </span>
                  <p className="text-sm text-on-surface-variant">{t(`walletStudent.${k}`)}</p>
                </li>
              ))}
            </ol>
            <button className="btn-ghost mt-5 w-full" onClick={() => setTopupOpen(true)}>
              <span className="material-symbols-outlined text-[20px]">add_card</span>
              {t('walletStudent.topup')}
            </button>
          </div>
        </aside>
      </div>

      <WalletTopupModal open={topupOpen} onClose={() => setTopupOpen(false)} />
    </div>
  );
}

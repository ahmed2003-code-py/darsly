import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { egp } from '../lib/format';
import { backoffInterval } from '../lib/livePolling';
import LiveTransferForm, { type DeclareInput, type ProofInput } from './live/LiveTransferForm';
import PaymentStageNote from './payments/PaymentStageNote';
import { ErrorNote, Field, Modal, Spinner } from './ui';

/** The server's view of a top-up (see WalletService.topupView). */
interface TopupView {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  stage: string;
  amountCents: number;
  method: string;
  transferSource: 'WALLET' | 'BANK' | null;
  senderWallet: string | null;
  payerName: string | null;
  claimedAt: string | null;
  rejectedReason: string | null;
  balanceCents: number;
}

/**
 * Adding money to the Darsly wallet — the same flow as a paid Live seat.
 *
 * Amount and source first; that writes a PENDING top-up, and only then are
 * Darsly's account and the exact amount shown. The transfer's SMS credits it
 * by itself and this modal shows the new balance as it lands. A receipt is
 * optional evidence for a reviewer, never the thing that confirms.
 */
export default function WalletTopupModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  // The top-up this modal is following. Found from the open one on the server
  // first, then kept by id so its confirmation is still seen after it stops
  // being "open".
  const [topupId, setTopupId] = useState<string | null>(null);

  const since = useRef(Date.now());
  const lastState = useRef<string | null>(null);
  const openTopup = useQuery({
    queryKey: ['topup-open'],
    queryFn: async (): Promise<TopupView | null> =>
      (await api.get('/wallet/topups/open')).data || null,
    enabled: open && !topupId,
  });
  useEffect(() => {
    if (openTopup.data?.id) setTopupId(openTopup.data.id);
  }, [openTopup.data?.id]);

  const topup = useQuery({
    queryKey: ['topup', topupId],
    queryFn: async (): Promise<TopupView> => {
      const data = (await api.get(`/wallet/topups/${topupId}`)).data;
      const key = `${data.status}:${data.stage}`;
      if (key !== lastState.current) {
        lastState.current = key;
        since.current = Date.now();
      }
      return data;
    },
    enabled: open && !!topupId,
    refetchInterval: (q) =>
      q.state.data?.status === 'PENDING' ? backoffInterval(since.current) : false,
  });
  const view = topupId ? (topup.data ?? null) : null;

  const credited = view?.status === 'APPROVED';
  useEffect(() => {
    if (credited) qc.invalidateQueries({ queryKey: ['wallet'] });
  }, [credited, qc]);

  const settle = (data: TopupView) => {
    since.current = Date.now();
    qc.setQueryData(['topup', data.id], data);
    setTopupId(data.id);
    qc.invalidateQueries({ queryKey: ['wallet'] });
  };
  const amountCents = Math.round(parseFloat(amount || '0') * 100);
  const declare = useMutation({
    mutationFn: async (input: DeclareInput) =>
      (
        await api.post('/wallet/topups/declare', {
          amountCents: view?.amountCents ?? amountCents,
          ...input,
        })
      ).data as TopupView,
    onSuccess: settle,
  });
  const proof = useMutation({
    mutationFn: async (input: ProofInput) =>
      (await api.post(`/wallet/topups/${view?.id}/proof`, input)).data as TopupView,
    onSuccess: settle,
  });

  function close() {
    // A finished top-up is not resumed next time; an open one is.
    if (view && view.status !== 'PENDING') setTopupId(null);
    setAmount('');
    qc.invalidateQueries({ queryKey: ['topup-open'] });
    onClose();
  }

  let body: JSX.Element;
  if ((openTopup.isLoading && !topupId) || (topupId && topup.isLoading)) {
    body = (
      <div
        className="flex flex-col items-center gap-2 py-10 text-sm text-on-surface-variant"
        aria-live="polite"
      >
        <Spinner />
        {t('checkout.preparing')}
      </div>
    );
  } else if (credited && view) {
    body = (
      <div
        className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center"
        role="status"
      >
        <span className="material-symbols-outlined mb-2 text-5xl text-secondary">verified</span>
        <p className="font-heading text-lg font-bold">{t('checkout.topupConfirmedTitle')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {t('checkout.topupConfirmedBody', { amount: egp(view.amountCents) })}
        </p>
        <p className="mt-3 font-heading text-2xl font-bold text-primary tabular-nums">
          {t('checkout.newBalance', { amount: egp(view.balanceCents) })}
        </p>
        <button className="btn-primary mt-5" onClick={close}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (view && view.status === 'REJECTED') {
    body = (
      <div className="rounded-2xl border border-outline-variant/60 p-6 text-center">
        <span className="material-symbols-outlined mb-2 text-5xl text-outline">event_busy</span>
        <p className="font-heading text-lg font-bold">{t('checkout.closedTitle')}</p>
        {view.rejectedReason && (
          <p className="mt-1 text-sm text-on-surface-variant">{view.rejectedReason}</p>
        )}
        <button
          className="btn-primary mt-5"
          onClick={() => {
            setTopupId(null);
            qc.setQueryData(['topup-open'], null);
          }}
        >
          {t('checkout.newTopup')}
        </button>
      </div>
    );
  } else if (view && view.claimedAt) {
    body = (
      <div
        className="rounded-2xl border border-outline-variant/60 p-6 text-center"
        aria-live="polite"
      >
        <span className="material-symbols-outlined mb-2 text-5xl text-primary">
          {view.stage === 'UNDER_REVIEW' ? 'fact_check' : 'hourglass_top'}
        </span>
        <p className="font-heading text-lg font-bold">
          {view.stage === 'UNDER_REVIEW' ? t('livePay.reviewTitle') : t('checkout.checkingTitle')}
        </p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {view.stage === 'UNDER_REVIEW'
            ? t('checkout.reviewBodyTopup')
            : t('checkout.checkingBodyTopup')}
        </p>
        <button className="btn-ghost mt-5" onClick={close}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (view) {
    body = (
      <div>
        <PaymentStageNote stage={view.stage} target="topup" />
        <LiveTransferForm
          purchase={{ studentPaysCents: view.amountCents, payment: view }}
          underReview={view.stage === 'UNDER_REVIEW'}
          onDeclare={(input) => declare.mutate(input)}
          declaring={declare.isPending}
          declareError={declare.error}
          onSubmitProof={(input) => proof.mutate(input)}
          pending={proof.isPending}
          error={proof.error}
          autoConfirmNote={t('checkout.autoConfirmTopup')}
        />
      </div>
    );
  } else {
    const amountOk = amountCents >= 1000;
    body = (
      <div className="space-y-4">
        <Field
          label={t('walletStudent.amount')}
          hint={t('walletStudent.amountHint')}
          id="topup-amount"
        >
          <input
            id="topup-amount"
            className="input"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="100"
          />
        </Field>
        {amountOk ? (
          <LiveTransferForm
            purchase={{ studentPaysCents: amountCents, payment: null }}
            onDeclare={(input) => declare.mutate(input)}
            declaring={declare.isPending}
            declareError={declare.error}
            onSubmitProof={(input) => proof.mutate(input)}
            pending={proof.isPending}
            error={proof.error}
            autoConfirmNote={t('checkout.autoConfirmTopup')}
          />
        ) : (
          amount && (
            <p className="text-xs text-on-surface-variant">{t('walletStudent.blockAmount')}</p>
          )
        )}
        <ErrorNote error={openTopup.error} />
      </div>
    );
  }

  return (
    <Modal open={open} onClose={close} title={t('walletStudent.topupTitle')} wide>
      {body}
    </Modal>
  );
}

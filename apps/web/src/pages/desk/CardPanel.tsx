import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, ErrorNote, Modal } from '../../components/ui';
import { dateShort } from '../../lib/format';
import { IssuedCard, useCardActions, useCardState } from '../../lib/desk';
import { CARD_CSS, cardMarkup, printCards, qrSvg } from './cardPrint';

const REVOKE_REASONS = ['LOST', 'DAMAGED', 'SECURITY', 'MANUAL', 'OTHER'] as const;
const REISSUE_REASONS = ['LOST', 'DAMAGED', 'SECURITY', 'REISSUED', 'OTHER'] as const;

/**
 * A learner's QR card, for someone holding card.manage: whether they have
 * one, and issue / reissue / revoke. Issuing or reissuing opens the print
 * preview straight away — the token exists only in that moment (the server
 * keeps a digest), so "print again" is a reissue, and the screen says so.
 */
export default function CardPanel({
  academyId,
  academyStudentId,
  withdrawn,
  compact = false,
}: {
  academyId: string;
  academyStudentId: string;
  withdrawn: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const state = useCardState(academyId, academyStudentId, true);
  const act = useCardActions(academyId, academyStudentId);
  const [printing, setPrinting] = useState<IssuedCard | null>(null);
  const [asking, setAsking] = useState<'reissue' | 'revoke' | null>(null);
  const active = state.data?.active ?? null;
  const lastRevoked = state.data?.history.find((c) => c.revokedAt) ?? null;

  if (state.isLoading) return null;
  return (
    <div className={compact ? '' : 'mt-3 border-t border-outline-variant/40 pt-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="material-symbols-outlined text-xl text-on-surface-variant" aria-hidden>
          qr_code_2
        </span>
        <span className="text-sm font-semibold">{t('card.title')}</span>
        {active ? (
          <Badge tone="primary">{t('card.state.ACTIVE')}</Badge>
        ) : lastRevoked ? (
          <Badge tone="warn">{t('card.state.REVOKED')}</Badge>
        ) : (
          <Badge tone="neutral">{t('card.state.NONE')}</Badge>
        )}
        {active && (
          <span className="text-xs text-outline">
            {t('card.issuedOn', { date: dateShort(active.issuedAt) })}
          </span>
        )}
        <div className="ms-auto flex flex-wrap gap-2">
          {!active && !withdrawn && (
            <button
              type="button"
              className="btn-primary min-h-11 px-4 text-sm"
              disabled={act.issue.isPending}
              aria-busy={act.issue.isPending}
              onClick={() => act.issue.mutate(undefined, { onSuccess: setPrinting })}
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                add_card
              </span>
              {t('card.issue')}
            </button>
          )}
          {active && !withdrawn && (
            <button
              type="button"
              className="btn-secondary min-h-11 px-4 text-sm"
              onClick={() => setAsking('reissue')}
            >
              {t('card.reissue')}
            </button>
          )}
          {active && (
            <button
              type="button"
              className="btn-ghost min-h-11 px-3 text-sm text-error"
              onClick={() => setAsking('revoke')}
            >
              {t('card.revoke')}
            </button>
          )}
        </div>
      </div>
      {active && !withdrawn && (
        <p className="mt-1 text-xs text-on-surface-variant">{t('card.printAgainHint')}</p>
      )}
      <ErrorNote error={act.issue.error} />

      {asking && active && (
        <ReasonDialog
          kind={asking}
          pending={act.reissue.isPending || act.revoke.isPending}
          error={asking === 'reissue' ? act.reissue.error : act.revoke.error}
          onClose={() => setAsking(null)}
          onConfirm={(reason) =>
            asking === 'reissue'
              ? act.reissue.mutate(
                  { cardId: active.id, reason },
                  {
                    onSuccess: (r) => {
                      setAsking(null);
                      setPrinting(r);
                    },
                  },
                )
              : act.revoke.mutate(
                  { cardId: active.id, reason },
                  { onSuccess: () => setAsking(null) },
                )
          }
        />
      )}
      {printing && <PrintPreview card={printing} onClose={() => setPrinting(null)} />}
    </div>
  );
}

function ReasonDialog({
  kind,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  kind: 'reissue' | 'revoke';
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const reasons = kind === 'revoke' ? REVOKE_REASONS : REISSUE_REASONS;
  const [reason, setReason] = useState<string>(reasons[0]);
  return (
    <Modal open title={t(`card.${kind}Title`)} onClose={onClose}>
      <p className="mb-4 text-sm text-on-surface-variant">{t(`card.${kind}Body`)}</p>
      <label className="mb-4 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
          {t('card.reason')}
        </span>
        <select
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        >
          {reasons.map((r) => (
            <option key={r} value={r}>
              {t(`card.reasons.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote error={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${kind === 'revoke' ? 'btn-primary bg-error text-on-error' : 'btn-primary'} min-h-11 px-5`}
          disabled={pending}
          aria-busy={pending}
          onClick={() => onConfirm(reason)}
        >
          {t(`card.${kind}Confirm`)}
        </button>
      </div>
    </Modal>
  );
}

/** The card as it will print, and the Print button. The token lives only in this component. */
function PrintPreview({ card, onClose }: { card: IssuedCard; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [markup, setMarkup] = useState<string | null>(null);
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const labels = {
    code: t('card.print.code'),
    card: t('card.print.kind'),
    note: t('card.print.note'),
  };
  // 85.6 mm at 96 dpi ≈ 323.5 px: scale the preview down when the dialog is narrower.
  const fitRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / 323.5));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    void qrSvg(card.token).then(
      (svg) => live && setMarkup(cardMarkup(card.print, svg, lang, labels)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.token, lang]);
  return (
    <Modal open title={t('card.print.title')} onClose={onClose}>
      <style>{CARD_CSS}</style>
      <p className="mb-3 text-sm text-on-surface-variant">{t('card.print.hint')}</p>
      {/* The card at its printed size, shrunk to fit a narrow phone (print is untouched). */}
      <div ref={fitRef} className="mb-4 flex justify-center" style={{ height: `${54 * scale}mm` }}>
        {markup ? (
          // Our own escaped markup (cardPrint.ts), never user HTML.
          <div
            style={{
              flex: 'none',
              width: '85.6mm',
              transform: `scale(${scale})`,
              transformOrigin: 'top center',
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : (
          <div className="h-[54mm] w-[85.6mm] max-w-full animate-pulse rounded-xl bg-surface-container" />
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={onClose}>
          {t('card.print.done')}
        </button>
        <button
          type="button"
          className="btn-primary min-h-11 px-5"
          disabled={!markup}
          onClick={() => markup && printCards([markup], lang, t('card.print.title'))}
          autoFocus
        >
          <span className="material-symbols-outlined text-lg" aria-hidden>
            print
          </span>
          {t('card.print.print')}
        </button>
      </div>
    </Modal>
  );
}

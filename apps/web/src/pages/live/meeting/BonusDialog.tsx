import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Modal } from '../../../components/ui';

export const BONUS_REASONS = ['CORRECT_ANSWER', 'GREAT_PARTICIPATION', 'SOLVED_IT'] as const;
export type BonusReason = (typeof BONUS_REASONS)[number];
const PRESETS = [1, 2, 5];
/** The rule's default per-award limit; the server has the real one and says so. */
const MAX_PER_AWARD = 10;

/** A v4 UUID (randomUUID where the browser has it). */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * "مكافأة": pick the points (+1 / +2 / +5 / custom), optionally a reason,
 * then one deliberate "منح". The request id is made when the dialog opens,
 * so a retry after a network hiccup is the same award, never a second one.
 */
export default function BonusDialog({
  name,
  onClose,
  onGrant,
}: {
  name: string;
  onClose: () => void;
  onGrant: (b: { points: number; reasonKey?: BonusReason; reason?: string; requestId: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const requestId = useMemo(uuid, []);
  const [points, setPoints] = useState(2);
  const [custom, setCustom] = useState('');
  const [reasonKey, setReasonKey] = useState<BonusReason | null>('CORRECT_ANSWER');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = custom ? Number(custom) : points;
  const valid = Number.isInteger(chosen) && chosen >= 1 && chosen <= MAX_PER_AWARD;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onGrant({
        points: chosen,
        ...(reasonKey ? { reasonKey } : {}),
        ...(!reasonKey && reason.trim() ? { reason: reason.trim() } : {}),
        requestId,
      });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const chip = (active: boolean) =>
    `rounded-full px-3.5 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      active ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
    }`;

  return (
    <Modal open onClose={onClose} title={t('bonus.title', { name })}>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-bold text-on-surface-variant">{t('bonus.points')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={chip(!custom && points === p)}
                aria-pressed={!custom && points === p}
                onClick={() => {
                  setCustom('');
                  setPoints(p);
                }}
              >
                +{p}
              </button>
            ))}
            <label className="inline-flex items-center gap-1.5 text-sm">
              <span className="text-on-surface-variant">{t('bonus.custom')}</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_PER_AWARD}
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
                className="w-16 rounded-xl border border-outline-variant bg-surface px-2 py-2 text-center text-sm tabular-nums"
                aria-label={t('bonus.custom')}
              />
            </label>
          </div>
          {custom && !valid && <p className="mt-1 text-xs text-error">{t('bonus.range', { max: MAX_PER_AWARD })}</p>}
        </div>

        <div>
          <p className="mb-2 text-xs font-bold text-on-surface-variant">{t('bonus.reason')}</p>
          <div className="flex flex-wrap gap-2">
            {BONUS_REASONS.map((r) => (
              <button key={r} type="button" className={chip(reasonKey === r)} aria-pressed={reasonKey === r} onClick={() => setReasonKey(r)}>
                {t(`bonus.reasons.${r}`)}
              </button>
            ))}
            <button type="button" className={chip(reasonKey === null)} aria-pressed={reasonKey === null} onClick={() => setReasonKey(null)}>
              {t('bonus.reasons.OTHER')}
            </button>
          </div>
          {reasonKey === null && (
            <input
              className="input mt-2 w-full"
              dir="auto"
              maxLength={80}
              value={reason}
              placeholder={t('bonus.reasonPh')}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </div>

        <ErrorNote error={error} />
        <p className="text-xs text-outline">{t('bonus.note')}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost justify-center" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn-primary justify-center" disabled={!valid || busy} onClick={() => void submit()}>
            <span aria-hidden className="material-symbols-outlined text-[18px]">
              redeem
            </span>
            {busy ? t('common.saving') : t('bonus.give', { points: valid ? chosen : '' })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

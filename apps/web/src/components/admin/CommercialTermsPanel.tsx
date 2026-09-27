import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseMoneyToCents } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { ErrorNote, Field, Spinner } from '../ui';

interface Terms {
  id: string;
  academyId: string | null;
  feeType: 'PERCENT' | 'FIXED';
  feeBps: number | null;
  feeFixedCents: number | null;
  feeMode: 'ADDITIVE' | 'DEDUCTED';
  feeRefundableOnStudentCancel: boolean;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  inherited?: boolean;
}

/** "10%" / "7.5%" / "25 ج.م" — basis points and piasters, shown without floats. */
export function feeLabel(t: Pick<Terms, 'feeType' | 'feeBps' | 'feeFixedCents'>) {
  if (t.feeType === 'PERCENT') {
    const bps = t.feeBps ?? 0;
    const whole = Math.floor(bps / 100);
    const frac = bps % 100;
    return `${whole}${frac ? `.${String(frac).padStart(2, '0').replace(/0$/, '')}` : ''}%`;
  }
  return egp(t.feeFixedCents ?? 0);
}

/** Percent text ("7.5") → basis points (750), exactly. */
function percentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/**
 * Darsly's commercial terms for Live sales — for one academy, or the platform
 * default (academyId null). Versions are append-only: this shows the one in
 * force and the history, and "change" always adds a new version.
 */
export default function CommercialTermsPanel({ academyId }: { academyId: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const url = academyId
    ? `/admin/academies/${academyId}/commercial-terms`
    : '/admin/commercial-terms/default';
  const { data, isLoading } = useQuery({
    queryKey: ['commercial-terms', academyId],
    queryFn: async () => (await api.get(url)).data,
  });
  const [editing, setEditing] = useState(false);
  const [feeType, setFeeType] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [value, setValue] = useState('');
  const [feeMode, setFeeMode] = useState<'ADDITIVE' | 'DEDUCTED'>('ADDITIVE');
  const [refundable, setRefundable] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');

  const parsed = feeType === 'PERCENT' ? percentToBps(value) : parseMoneyToCents(value);
  const invalid =
    parsed == null || (feeType === 'PERCENT' && feeMode === 'DEDUCTED' && parsed >= 10_000);

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.post(url, {
          feeType,
          ...(feeType === 'PERCENT' ? { feeBps: parsed } : { feeFixedCents: parsed }),
          feeMode,
          feeRefundableOnStudentCancel: refundable,
          ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom).toISOString() } : {}),
          note: note.trim() || undefined,
        })
      ).data,
    onSuccess: () => {
      setEditing(false);
      setValue('');
      setNote('');
      setEffectiveFrom('');
      qc.invalidateQueries({ queryKey: ['commercial-terms', academyId] });
    },
  });

  if (isLoading) return <Spinner />;
  const eff: Terms | null = data?.effective ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-outline-variant p-4">
        <p className="text-sm text-on-surface-variant">{t('adminTerms.effective')}</p>
        {eff ? (
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-heading text-2xl font-bold tabular-nums">{feeLabel(eff)}</span>
            <span className="rounded-full bg-primary-fixed px-2.5 py-0.5 text-xs font-bold text-on-primary-fixed">
              {t(`adminTerms.mode.${eff.feeMode}`)}
            </span>
            <span className="text-xs text-on-surface-variant">
              {eff.feeRefundableOnStudentCancel
                ? t('adminTerms.feeRefundable')
                : t('adminTerms.feeKept')}
            </span>
            {eff.inherited && (
              <span className="text-xs text-outline">{t('adminTerms.inherited')}</span>
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-error">{t('adminTerms.none')}</p>
        )}
        <p className="mt-2 text-xs text-outline">
          {t(eff?.feeMode === 'DEDUCTED' ? 'adminTerms.deductedHint' : 'adminTerms.additiveHint')}
        </p>
      </div>

      {!editing ? (
        <button className="btn-ghost" onClick={() => setEditing(true)}>
          <span className="material-symbols-outlined text-base">add</span>
          {t('adminTerms.newVersion')}
        </button>
      ) : (
        <form
          noValidate
          className="space-y-3 rounded-2xl border border-outline-variant p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && !create.isPending) create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('adminTerms.feeType')} id="terms-type">
              <select
                id="terms-type"
                className="input"
                value={feeType}
                onChange={(e) => setFeeType(e.target.value as 'PERCENT' | 'FIXED')}
              >
                <option value="PERCENT">{t('adminTerms.percent')}</option>
                <option value="FIXED">{t('adminTerms.fixed')}</option>
              </select>
            </Field>
            <Field
              label={
                feeType === 'PERCENT' ? t('adminTerms.valuePercent') : t('adminTerms.valueFixed')
              }
              id="terms-value"
            >
              <input
                id="terms-value"
                className="input tabular-nums"
                dir="ltr"
                inputMode="decimal"
                value={value}
                aria-invalid={!!value && invalid}
                placeholder={feeType === 'PERCENT' ? '10' : '25'}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            <Field label={t('adminTerms.feeMode')} id="terms-mode">
              <select
                id="terms-mode"
                className="input"
                value={feeMode}
                onChange={(e) => setFeeMode(e.target.value as 'ADDITIVE' | 'DEDUCTED')}
              >
                <option value="ADDITIVE">{t('adminTerms.mode.ADDITIVE')}</option>
                <option value="DEDUCTED">{t('adminTerms.mode.DEDUCTED')}</option>
              </select>
            </Field>
            <Field
              label={t('adminTerms.effectiveFrom')}
              id="terms-from"
              hint={t('adminTerms.effectiveFromHint')}
            >
              <input
                id="terms-from"
                className="input"
                type="datetime-local"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={refundable}
              onChange={(e) => setRefundable(e.target.checked)}
            />
            {t('adminTerms.refundableLabel')}
          </label>
          <Field label={t('adminTerms.note')} id="terms-note">
            <input
              id="terms-note"
              className="input"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <ErrorNote error={create.error} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={invalid || create.isPending}>
              {create.isPending ? t('common.saving') : t('adminTerms.save')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {!!data?.versions?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/40 text-on-surface-variant">
                <th className="px-3 py-2 text-start">{t('adminTerms.fee')}</th>
                <th className="px-3 py-2 text-start">{t('adminTerms.feeMode')}</th>
                <th className="px-3 py-2 text-start">{t('adminTerms.effectiveFrom')}</th>
                <th className="px-3 py-2 text-start">{t('adminTerms.note')}</th>
              </tr>
            </thead>
            <tbody>
              {data.versions.map((v: Terms) => (
                <tr
                  key={v.id}
                  className={`border-b border-outline-variant/30 ${v.id === eff?.id ? 'font-bold' : ''}`}
                >
                  <td className="px-3 py-2 tabular-nums">{feeLabel(v)}</td>
                  <td className="px-3 py-2">{t(`adminTerms.mode.${v.feeMode}`)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {new Date(v.effectiveFrom).toLocaleString('ar-EG')}
                  </td>
                  <td className="px-3 py-2 text-on-surface-variant">{v.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {academyId && data?.academy?.kind === 'CENTER' && (
        <div className="rounded-2xl border border-outline-variant p-4">
          <p className="mb-2 font-heading font-bold">{t('adminTerms.splits')}</p>
          <p className="mb-2 text-xs text-outline">
            {t('adminTerms.centerDefault', {
              pct:
                data.academy.teacherSharePercent == null
                  ? '—'
                  : `${data.academy.teacherSharePercent}%`,
            })}
          </p>
          <ul className="space-y-1 text-sm">
            {data.splits.map((sp: any) => (
              <li key={sp.userId} className="flex justify-between">
                <span>{sp.fullName}</span>
                <span className={`tabular-nums ${sp.effectivePercent == null ? 'text-error' : ''}`}>
                  {sp.effectivePercent == null
                    ? t('adminTerms.noSplit')
                    : `${sp.effectivePercent}%`}
                  {sp.ownPercent != null && (
                    <span className="ms-1 text-xs text-outline">
                      ({t('adminTerms.ownAgreement')})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { dateShort } from '../../lib/format';
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';

interface DeviceRow {
  id: string;
  phone: string;
  model: string | null;
  revokedAt: string | null;
  lastSeenAt: string;
  smsCount?: number;
}
interface MintedCode {
  code: string;
  phone: string;
  expiresAt: string;
}

/** Seconds left, ticking, so a stale code is obvious rather than mysterious. */
function useCountdown(until?: string) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return left;
}

/**
 * Authorising the phone that reads payment SMS. Minting a code used to mean a
 * shell and a database, which put the one routine step of setting up a
 * listener out of reach of the person who owns it.
 */
export default function AdminDevicesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [copied, setCopied] = useState(false);
  const left = useCountdown(minted?.expiresAt);

  const { data: devices, isLoading } = useQuery<DeviceRow[]>({
    queryKey: ['admin-devices'],
    queryFn: async () => (await api.get('/admin/device/devices')).data,
  });

  const mint = useMutation({
    mutationFn: async () =>
      (await api.post('/admin/device/enrollment-codes', { phone: phone.trim(), label: label.trim() || undefined }))
        .data as MintedCode,
    onSuccess: (data) => {
      setMinted(data);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ['admin-devices'] });
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/device/devices/${id}/revoke`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-devices'] }),
  });

  const copy = async () => {
    if (!minted) return;
    await navigator.clipboard.writeText(minted.code).catch(() => undefined);
    setCopied(true);
  };

  return (
    <div className="page">
      <PageHeader title={t('adminDevices.title')} subtitle={t('adminDevices.subtitle')} />
      <ErrorNote error={mint.error || revoke.error} />

      {/* Mint */}
      <div className="card mb-6 space-y-4">
        <p className="font-heading text-lg font-bold">{t('adminDevices.newCode')}</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1.5 block text-sm font-bold">{t('adminDevices.phone')}</span>
            <input
              className="input"
              dir="ltr"
              inputMode="tel"
              placeholder="01002589923"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-bold">{t('adminDevices.label')}</span>
            <input
              className="input"
              placeholder={t('adminDevices.labelHint')}
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button
            className="btn-primary h-11 whitespace-nowrap"
            disabled={mint.isPending || phone.trim().length < 10}
            onClick={() => mint.mutate()}
          >
            <span className="material-symbols-outlined text-[20px]">key</span>
            {mint.isPending ? t('common.saving') : t('adminDevices.generate')}
          </button>
        </div>

        {minted && (
          <div
            className={`rounded-2xl border p-5 text-center transition ${
              left > 0 ? 'border-primary/40 bg-primary-fixed/40' : 'border-error/40 bg-error-container/40'
            }`}
          >
            <p className="text-xs font-bold text-on-surface-variant">
              {t('adminDevices.codeFor', { phone: minted.phone })}
            </p>
            <p className="my-2 font-heading text-5xl font-extrabold tracking-[0.15em] text-primary" dir="ltr">
              {minted.code}
            </p>
            {left > 0 ? (
              <p className="text-sm text-on-surface-variant">
                {t('adminDevices.expiresIn', {
                  time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
                })}
              </p>
            ) : (
              <p className="text-sm font-bold text-error">{t('adminDevices.expired')}</p>
            )}
            <div className="mt-3 flex justify-center gap-2">
              <button className="btn-ghost" onClick={copy} disabled={left === 0}>
                <span className="material-symbols-outlined text-[20px]">content_copy</span>
                {copied ? t('adminDevices.copied') : t('adminDevices.copy')}
              </button>
              {left === 0 && (
                <button className="btn-primary" onClick={() => mint.mutate()} disabled={mint.isPending}>
                  {t('adminDevices.generateAgain')}
                </button>
              )}
            </div>
            <p className="mt-3 text-xs text-outline">{t('adminDevices.onceHint')}</p>
          </div>
        )}
      </div>

      {/* Enrolled phones */}
      <p className="mb-3 font-heading text-lg font-bold">{t('adminDevices.enrolled')}</p>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : !devices?.length ? (
        <EmptyState icon="smartphone" title={t('adminDevices.noDevices')} />
      ) : (
        <div className="space-y-3">
          {devices.map((d) => (
            <div key={d.id} className="card flex flex-wrap items-center gap-4">
              <span
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${
                  d.revokedAt ? 'bg-error-container text-on-error-container' : 'bg-primary-fixed text-on-primary-fixed'
                }`}
              >
                <span className="material-symbols-outlined">smartphone</span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold" dir="ltr">{d.phone}</p>
                <p className="text-sm text-on-surface-variant">
                  {d.model ?? '—'}
                  {typeof d.smsCount === 'number' ? ` · ${t('adminDevices.smsCount', { count: d.smsCount })}` : ''}
                </p>
                <p className="text-xs text-outline">
                  {d.revokedAt
                    ? t('adminDevices.revokedAt', { date: dateShort(d.revokedAt) })
                    : t('adminDevices.lastSeen', { date: dateShort(d.lastSeenAt) })}
                </p>
              </div>
              {!d.revokedAt && (
                <button
                  className="btn-ghost text-error"
                  disabled={revoke.isPending}
                  onClick={async () => (await askConfirm(t('adminDevices.revokeConfirm'))) && revoke.mutate(d.id)}
                >
                  {t('adminDevices.revoke')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

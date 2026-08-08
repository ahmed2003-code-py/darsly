import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { dateShort } from '../lib/format';
import { imageToDataUrl } from '../lib/image';
import { setLanguage } from '../i18n';
import { useAuthStore } from '../stores/auth';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../components/ui';

interface DeviceSession {
  id: string;
  deviceName: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** A titled block, so the page reads as a set of decisions rather than a form. */
function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-fixed text-primary">
          <span className="material-symbols-outlined text-xl">{icon}</span>
        </span>
        <div>
          <h3 className="font-heading text-lg font-bold">{title}</h3>
          {hint && <p className="text-sm text-on-surface-variant">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-variant/40 py-3 last:border-0">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <span className="text-end">
        <span className="block font-semibold" dir="auto">
          {value}
        </span>
        {hint && <span className="block text-xs text-outline">{hint}</span>}
      </span>
    </div>
  );
}

export default function ProfilePage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, setUser, clear } = useAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: async () => (await api.get('/me/profile')).data,
  });
  useEffect(() => {
    if (data?.fullName) setName(data.fullName);
  }, [data]);

  // Every device currently holding a session for this account.
  const { data: sessions } = useQuery<DeviceSession[]>({
    queryKey: ['my-sessions'],
    queryFn: async () => (await api.get('/auth/sessions')).data,
  });

  const syncUser = (patch: Record<string, unknown>) => {
    if (user) setUser({ ...user, ...patch } as any);
    qc.invalidateQueries({ queryKey: ['my-profile'] });
  };

  const avatar = useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await imageToDataUrl(file, { maxW: 256, maxH: 256, quality: 0.85, square: true });
      return (await api.post('/me/avatar', { dataUrl })).data;
    },
    onSuccess: (d) => syncUser({ avatarUrl: d.avatarUrl }),
  });
  const removeAvatar = useMutation({
    mutationFn: async () => (await api.delete('/me/avatar')).data,
    onSuccess: () => syncUser({ avatarUrl: null }),
  });
  const saveName = useMutation({
    mutationFn: async () => (await api.patch('/me/profile', { fullName: name.trim() })).data,
    onSuccess: (d) => syncUser({ fullName: d.fullName }),
  });

  // There is no direct change-password endpoint; the platform's flow is the
  // hashed single-use reset link, so the button triggers exactly that.
  const resetPassword = useMutation({
    mutationFn: async () => (await api.post('/auth/forgot-password', { email: data?.email })).data,
  });

  const endSession = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/auth/sessions/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-sessions'] }),
  });

  async function logout() {
    // Best effort: the local session must be cleared even if the call fails,
    // otherwise a user who taps "sign out" offline stays signed in.
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    clear();
    navigate('/login', { replace: true });
  }

  if (isLoading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }

  const avatarUrl = data?.avatarUrl ?? user?.avatarUrl;
  const role = data?.role ?? user?.role;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      <div className="grid gap-5">
        {/* Identity */}
        <section className="card">
          <div className="flex flex-wrap items-center gap-5">
            <div className="relative">
              <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-primary-fixed text-3xl font-extrabold text-primary shadow-card">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (name?.trim()?.[0] ?? '?')
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && avatar.mutate(e.target.files[0])}
              />
              <button
                className="absolute -bottom-1 -end-1 grid h-9 w-9 place-items-center rounded-full bg-primary text-on-primary shadow-glow transition hover:scale-105"
                disabled={avatar.isPending}
                onClick={() => fileRef.current?.click()}
                title={t('profile.changePhoto')}
                aria-label={t('profile.changePhoto')}
              >
                <span className="material-symbols-outlined text-lg">
                  {avatar.isPending ? 'hourglass' : 'photo_camera'}
                </span>
              </button>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-heading text-xl font-extrabold">{data?.fullName}</p>
                {role && <Badge tone="primary">{t(`profile.role${role}`)}</Badge>}
              </div>
              <p className="text-sm text-outline" dir="ltr">
                {data?.email ?? data?.phone}
              </p>
              {avatarUrl && (
                <button
                  className="mt-2 text-sm text-error hover:underline"
                  onClick={() => removeAvatar.mutate()}
                >
                  {t('profile.removePhoto')}
                </button>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-outline-variant/40 pt-6">
            <Field label={t('profile.fullName')}>
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="flex items-center gap-3">
              <button
                className="btn-primary"
                disabled={saveName.isPending || !name.trim() || name.trim() === data?.fullName}
                onClick={() => saveName.mutate()}
              >
                {saveName.isPending ? t('common.saving') : t('common.save')}
              </button>
              {saveName.isSuccess && (
                <span className="text-sm font-semibold text-primary">{t('common.saved')}</span>
              )}
            </div>
            <ErrorNote error={saveName.error ?? avatar.error} />
          </div>
        </section>

        <Section icon="badge" title={t('profile.sectionAccount')}>
          <ReadOnlyRow
            label={t('profile.email')}
            value={data?.email ?? t('profile.notSet')}
            hint={data?.email ? t('profile.emailLocked') : undefined}
          />
          <ReadOnlyRow
            label={t('profile.phone')}
            value={data?.phone ?? t('profile.notSet')}
            hint={data?.phone ? t('profile.phoneLocked') : undefined}
          />
          {data?.createdAt && (
            <ReadOnlyRow label={t('profile.memberSince')} value={dateShort(data.createdAt)} />
          )}
        </Section>

        <Section icon="tune" title={t('profile.sectionPrefs')}>
          <Field label={t('profile.language')} hint={t('profile.languageHint')}>
            <select
              className="input py-2"
              value={i18n.language.startsWith('ar') ? 'ar' : 'en'}
              onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
            >
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </select>
          </Field>
        </Section>

        <Section icon="lock" title={t('profile.sectionSecurity')}>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant/40 pb-5">
            <div>
              <p className="font-semibold">{t('profile.password')}</p>
              <p className="text-sm text-on-surface-variant">{t('profile.passwordHint')}</p>
            </div>
            <button
              className="btn-secondary"
              disabled={!data?.email || resetPassword.isPending || resetPassword.isSuccess}
              onClick={() => resetPassword.mutate()}
            >
              {resetPassword.isSuccess ? t('profile.passwordSent') : t('profile.passwordSend')}
            </button>
          </div>

          <p className="mb-1 font-semibold">{t('profile.devices')}</p>
          <p className="mb-3 text-sm text-on-surface-variant">{t('profile.devicesHint')}</p>

          {!sessions?.length ? (
            <p className="text-sm text-outline">{t('profile.noDevices')}</p>
          ) : (
            <ul className="grid gap-2">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2.5"
                >
                  <span className="material-symbols-outlined text-outline">devices</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {s.deviceName || t('profile.deviceCurrent')}
                    </span>
                    <span className="block text-xs text-outline" dir="ltr">
                      {s.ip ? `${s.ip} · ` : ''}
                      {t('profile.deviceLastSeen')}: {dateShort(s.lastSeenAt)}
                    </span>
                  </span>
                  <button
                    className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error transition hover:bg-error-container/40"
                    disabled={endSession.isPending}
                    onClick={() => endSession.mutate(s.id)}
                  >
                    {t('profile.deviceEnd')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ErrorNote error={endSession.error ?? resetPassword.error} />
        </Section>

        <Section icon="logout" title={t('profile.sectionSession')}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{t('profile.logoutTitle')}</p>
              <p className="text-sm text-on-surface-variant">{t('profile.logoutHint')}</p>
            </div>
            <button
              className="rounded-xl border border-error/40 px-5 py-2.5 font-bold text-error transition hover:bg-error-container/40"
              onClick={() => window.confirm(t('profile.logoutConfirm')) && logout()}
            >
              <span className="material-symbols-outlined me-1 align-middle text-base">logout</span>
              {t('dashboard.logout')}
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}

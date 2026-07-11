import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { imageToDataUrl } from '../lib/image';
import { useAuthStore } from '../stores/auth';
import { Field, PageHeader, Spinner } from '../components/ui';

export default function ProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user, setUser } = useAuthStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: async () => (await api.get('/me/profile')).data,
  });
  useEffect(() => { if (data?.fullName) setName(data.fullName); }, [data]);

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

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  const avatarUrl = data?.avatarUrl ?? user?.avatarUrl;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      <div className="card">
        {/* Avatar */}
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative">
            <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-primary-fixed text-3xl font-extrabold text-primary shadow-card">
              {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : (name?.[0] ?? '؟')}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => e.target.files?.[0] && avatar.mutate(e.target.files[0])} />
            <button
              className="absolute -bottom-1 -end-1 grid h-9 w-9 place-items-center rounded-full bg-primary text-on-primary shadow-glow transition hover:scale-105"
              disabled={avatar.isPending}
              onClick={() => fileRef.current?.click()}
              title={t('profile.changePhoto')}
            >
              <span className="material-symbols-outlined text-lg">{avatar.isPending ? 'hourglass' : 'photo_camera'}</span>
            </button>
          </div>
          <div>
            <p className="font-heading text-xl font-extrabold">{data?.fullName}</p>
            <p className="text-sm text-outline" dir="ltr">{data?.email ?? data?.phone}</p>
            {avatarUrl && (
              <button className="mt-2 text-sm text-error hover:underline" onClick={() => removeAvatar.mutate()}>
                {t('profile.removePhoto')}
              </button>
            )}
          </div>
        </div>

        {/* Name */}
        <div className="mt-6 border-t border-outline-variant/40 pt-6">
          <Field label={t('profile.fullName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button className="btn-primary" disabled={saveName.isPending || !name.trim() || name.trim() === data?.fullName} onClick={() => saveName.mutate()}>
            {saveName.isPending ? t('common.saving') : t('common.save')}
          </button>
          {saveName.isSuccess && <span className="ms-3 text-sm text-secondary">{t('common.saved')}</span>}
        </div>

        {/* Read-only account info */}
        <div className="mt-6 grid gap-3 border-t border-outline-variant/40 pt-6 text-sm sm:grid-cols-2">
          <div>
            <p className="text-outline">{t('profile.email')}</p>
            <p className="font-bold" dir="ltr">{data?.email ?? '—'}</p>
          </div>
          <div>
            <p className="text-outline">{t('profile.phone')}</p>
            <p className="font-bold" dir="ltr">{data?.phone ?? '—'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

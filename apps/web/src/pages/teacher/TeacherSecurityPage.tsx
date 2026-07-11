import { useMutation, useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Badge, ErrorNote, PageHeader, Skeleton } from '../../components/ui';

const SEV_TONE: Record<string, 'error' | 'warn' | 'neutral'> = {
  CRITICAL: 'error', WARNING: 'warn', INFO: 'neutral',
};

export default function TeacherSecurityPage() {
  const { t } = useTranslation();
  const [wm, setWm] = useState('');

  const { data: events, isLoading } = useQuery({
    queryKey: ['security-events'],
    queryFn: async () => (await api.get('/teacher/security/events')).data,
    refetchInterval: 30_000,
  });
  const { data: sessions } = useQuery({
    queryKey: ['security-sessions'],
    queryFn: async () => (await api.get('/teacher/security/sessions')).data,
  });

  const trace = useMutation({
    mutationFn: async (id: string) => (await api.get(`/teacher/security/trace/${id.trim()}`)).data,
  });

  const critical = (events ?? []).filter((e: any) => e.severity === 'CRITICAL' && !e.resolvedAt);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('security.title')} subtitle={t('security.subtitle')} />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Suspicious session alerts */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-heading text-xl font-extrabold">
            <span className="material-symbols-outlined text-error">warning</span>
            {t('security.activeAlerts')}
          </h2>
          {isLoading ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : !critical.length ? (
            <div className="card py-10 text-center text-outline">
              <span className="material-symbols-outlined mb-2 text-4xl text-secondary">verified_user</span>
              <p>{t('security.noAlerts')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {critical.map((e: any) => (
                <div key={e.id} className="card border-s-4 border-error p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-bold text-error">{t(`security.eventTypes.${e.type}`)}</p>
                    <Badge tone={SEV_TONE[e.severity]}>{e.severity}</Badge>
                  </div>
                  {e.student && (
                    <p className="mt-1 text-sm text-on-surface-variant">
                      {e.student.user.fullName} · <span dir="ltr">{e.student.user.phone}</span>
                    </p>
                  )}
                  {e.meta?.ips && (
                    <p className="mt-1 text-xs text-outline" dir="ltr">IPs: {(e.meta.ips as string[]).join(' , ')}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* All events list */}
          {events?.length > 0 && (
            <div className="card mt-4">
              <h3 className="mb-2 font-heading font-bold">{t('admin.securityTitle')}</h3>
              <ul className="divide-y divide-outline-variant/40 text-sm">
                {events.slice(0, 12).map((e: any) => (
                  <li key={e.id} className="flex items-center justify-between py-2">
                    <span className="flex items-center gap-2">
                      <Badge tone={SEV_TONE[e.severity]}>{e.severity}</Badge>
                      {t(`security.eventTypes.${e.type}`)}
                    </span>
                    <span className="text-xs text-outline">{e.student?.user?.fullName ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Leak-Trace + sessions */}
        <section className="space-y-6">
          <div className="card bg-gradient-to-bl from-primary-fixed/60 to-surface-container-lowest">
            <h2 className="mb-2 flex items-center gap-2 font-heading text-xl font-extrabold">
              <span className="material-symbols-outlined text-primary">fingerprint</span>
              {t('security.leakTraceTitle')}
            </h2>
            <p className="mb-4 text-sm text-on-surface-variant">{t('security.leakTraceHint')}</p>
            <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (wm.trim()) trace.mutate(wm); }}>
              <input className="input font-mono" dir="ltr" placeholder="DRS-89421-A8X9" value={wm}
                onChange={(e) => setWm(e.target.value)} />
              <button className="btn-primary px-6" disabled={!wm.trim() || trace.isPending}>{t('security.trace')}</button>
            </form>

            {trace.data && (
              <div className="mt-4 rounded-xl border border-error/30 bg-error-container/30 p-4">
                <p className="mb-2 font-heading font-bold text-error">{t('security.tracedStudent')}</p>
                <dl className="grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-outline">{t('security.tracedStudent')}</dt><dd className="font-bold">{trace.data.student.name}</dd>
                  <dt className="text-outline">{t('security.phone')}</dt><dd dir="ltr">{trace.data.student.phone}</dd>
                  <dt className="text-outline">{t('security.lesson')}</dt><dd>{trace.data.lesson}</dd>
                  <dt className="text-outline">{t('security.ip')}</dt><dd dir="ltr">{trace.data.ip ?? '—'}</dd>
                  <dt className="text-outline">{t('security.device')}</dt><dd className="truncate">{trace.data.device ?? '—'}</dd>
                  <dt className="text-outline">{t('security.time')}</dt><dd dir="ltr">{new Date(trace.data.startedAt).toLocaleString('en-GB')}</dd>
                </dl>
              </div>
            )}
            <ErrorNote error={trace.error} />
          </div>

          <div className="card">
            <h2 className="mb-3 font-heading text-xl font-bold">{t('security.sessions')}</h2>
            {!sessions?.length ? (
              <p className="py-4 text-center text-outline">{t('security.noSessions')}</p>
            ) : (
              <ul className="divide-y divide-outline-variant/40 text-sm">
                {sessions.slice(0, 10).map((s: any) => (
                  <li key={s.id} className="flex items-center justify-between py-2">
                    <div className="min-w-0">
                      <p className="truncate font-bold">{s.student.user.fullName}</p>
                      <p className="truncate text-xs text-outline">{s.lesson.title}</p>
                    </div>
                    <div className="text-end">
                      <p className="font-mono text-xs text-primary" dir="ltr">{s.watermarkId}</p>
                      <p className="text-xs text-outline" dir="ltr">{s.ip ?? '—'}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

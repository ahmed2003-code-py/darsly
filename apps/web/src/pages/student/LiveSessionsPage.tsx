import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Badge, CardGridSkeleton, EmptyState, ErrorNote, PageHeader } from '../../components/ui';

function when(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function startsInLabel(iso: string, t: any): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return t('live.liveNow');
  const h = Math.floor(diff / 3600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return t('live.inDays', { count: d });
  if (h > 0) return t('live.inHours', { count: h });
  return t('live.inMinutes', { count: Math.max(1, Math.floor(diff / 60_000)) });
}

export default function LiveSessionsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['live-upcoming'],
    queryFn: async () => (await api.get('/live/upcoming')).data,
  });

  const book = useMutation({
    mutationFn: async (id: string) => (await api.post(`/live/${id}/book`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-upcoming'] }),
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/live/${id}/book`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-upcoming'] }),
  });
  const join = useMutation({
    mutationFn: async (id: string) => (await api.get(`/live/${id}/join`)).data,
    onSuccess: (d) => { if (d.joinUrl) window.open(d.joinUrl, '_blank', 'noopener'); },
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('live.title')} subtitle={t('live.subtitle')} />
      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState icon="sensors" title={t('live.empty')} hint={t('live.emptyHint')} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.map((s: any) => {
            const soon = new Date(s.startsAt).getTime() - Date.now() < 15 * 60_000;
            const full = s.seatsLeft === 0 && !s.booked;
            return (
              <div key={s.id} className="card flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="flex h-2.5 w-2.5 items-center justify-center">
                        <span className={`h-2.5 w-2.5 rounded-full ${soon ? 'animate-pulse bg-error' : 'bg-secondary'}`} />
                      </span>
                      <span className="text-xs font-bold text-outline">{startsInLabel(s.startsAt, t)}</span>
                    </div>
                    <h3 className="font-heading text-lg font-bold">{s.title}</h3>
                    <p className="text-sm text-primary">{s.teacherName}</p>
                  </div>
                  {s.booked && <Badge tone="teal">{t('live.booked')}</Badge>}
                </div>

                {s.description && <p className="text-sm text-on-surface-variant" dir="auto">{s.description}</p>}

                <div className="flex flex-wrap items-center gap-4 text-xs text-outline">
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">event</span>{when(s.startsAt)}</span>
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">schedule</span>{t('live.minutes', { count: s.durationMin })}</span>
                  {s.capacity != null && (
                    <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">group</span>{t('live.seatsLeft', { count: s.seatsLeft })}</span>
                  )}
                </div>

                <div className="mt-auto flex gap-2">
                  {s.booked ? (
                    <>
                      <button className="btn-primary flex-1 py-2.5 text-sm" disabled={!soon || join.isPending} onClick={() => join.mutate(s.id)}>
                        <span className="material-symbols-outlined text-base">videocam</span>
                        {soon ? t('live.join') : t('live.joinOpensSoon')}
                      </button>
                      <button className="btn-ghost px-4 py-2.5 text-sm" disabled={cancel.isPending} onClick={() => cancel.mutate(s.id)}>
                        {t('live.cancel')}
                      </button>
                    </>
                  ) : (
                    <button className="btn-primary flex-1 py-2.5 text-sm" disabled={full || book.isPending} onClick={() => book.mutate(s.id)}>
                      <span className="material-symbols-outlined text-base">event_available</span>
                      {full ? t('live.full') : t('live.book')}
                    </button>
                  )}
                </div>
                <ErrorNote error={book.error || join.error} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

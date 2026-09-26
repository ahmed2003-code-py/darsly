import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { Markdown } from '../../lib/markdown';
import {
  Badge,
  CardGridSkeleton,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
} from '../../components/ui';
import SessionSummary from '../live/SessionSummary';
import LiveSessionForm from './LiveSessionForm';

function when(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TeacherLivePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [bookingsFor, setBookingsFor] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['teacher-live'],
    queryFn: async () => (await api.get('/teacher/live')).data,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/teacher/live/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-live'] }),
  });
  // Starting creates the room server-side; the page only navigates once it has.
  const start = useMutation({
    mutationFn: async (id: string) => (await api.post(`/teacher/live/${id}/start`)).data,
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['teacher-live'] });
      navigate(`/live/${id}/meeting`);
    },
  });
  // Finished sessions open into their own record: who came, and what the
  // lesson came to.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const { data: attendance } = useQuery({
    queryKey: ['live-attendance', detailFor],
    queryFn: async () => (await api.get(`/teacher/live/${detailFor}/attendance`)).data,
    enabled: !!detailFor,
  });

  const { data: bookings } = useQuery({
    queryKey: ['live-bookings', bookingsFor],
    queryFn: async () => (await api.get(`/teacher/live/${bookingsFor}/bookings`)).data,
    enabled: !!bookingsFor,
  });

  return (
    <div className="page">
      <div className="flex items-center justify-between">
        <PageHeader title={t('live.teacherTitle')} subtitle={t('live.teacherSubtitle')} />
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <span className="material-symbols-outlined">add</span>
          {t('live.schedule')}
        </button>
      </div>

      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState
          icon="sensors"
          title={t('live.teacherEmpty')}
          hint={t('live.teacherEmptyHint')}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((s: any) => {
            const endsAt = new Date(s.startsAt).getTime() + s.durationMin * 60_000;
            const past = s.status === 'ENDED' || endsAt < Date.now();
            const live = s.status === 'LIVE' && !past;
            // The doors open a quarter of an hour early, the same window the
            // server enforces — this only decides whether to offer the button.
            const canStart = !past && Date.now() >= new Date(s.startsAt).getTime() - 15 * 60_000;
            return (
              <div key={s.id} className="card flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 font-heading text-lg font-bold">{s.title}</h3>
                  {live ? (
                    <Badge tone="error">
                      <span className="me-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" />
                      {t('live.liveNow')}
                    </Badge>
                  ) : (
                    <Badge tone={past ? 'neutral' : 'teal'}>
                      {past ? t('live.ended') : t('live.upcoming')}
                    </Badge>
                  )}
                </div>
                {s.description && (
                  <Markdown className="text-sm text-on-surface-variant">{s.description}</Markdown>
                )}
                <div className="flex flex-wrap items-center gap-4 text-xs text-outline">
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">event</span>
                    {when(s.startsAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">schedule</span>
                    {t('live.minutes', { count: s.durationMin })}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button
                    className="flex items-center gap-1 text-sm font-bold text-primary hover:underline"
                    onClick={() => setBookingsFor(s.id)}
                  >
                    <span className="material-symbols-outlined text-base">group</span>
                    {t('live.bookedCount', { count: s.bookedCount })}
                    {s.capacity != null ? ` / ${s.capacity}` : ''}
                  </button>
                  <button
                    className="text-error/70 hover:text-error"
                    onClick={async () =>
                      (await askConfirm(t('live.cancelConfirm'))) && remove.mutate(s.id)
                    }
                  >
                    <span className="material-symbols-outlined text-base">delete</span>
                  </button>
                </div>

                {/* The meeting itself. A session already running is re-entered
                    rather than started again — that is the refresh case, and
                    the second-device case. */}
                {!past && (
                  <button
                    className="btn-primary w-full py-2.5 text-sm"
                    disabled={!canStart || start.isPending}
                    onClick={() => (live ? navigate(`/live/${s.id}/meeting`) : start.mutate(s.id))}
                  >
                    <span className="material-symbols-outlined text-base">videocam</span>
                    {live
                      ? t('live.continueMeeting')
                      : canStart
                        ? t('live.startMeeting')
                        : t('live.startOpensSoon')}
                  </button>
                )}
                <ErrorNote error={start.error} />

                {past && (
                  <button
                    className="btn-ghost w-full py-2.5 text-sm"
                    onClick={() => setDetailFor(s.id)}
                  >
                    <span className="material-symbols-outlined text-base">description</span>
                    {t('live.viewSession')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create */}
      <Modal open={open} onClose={() => setOpen(false)} title={t('live.newSession')}>
        {open && (
          <LiveSessionForm
            onCancel={() => setOpen(false)}
            onCreated={() => {
              setOpen(false);
              qc.invalidateQueries({ queryKey: ['teacher-live'] });
            }}
          />
        )}
      </Modal>

      {/* What a finished lesson left behind. */}
      <Modal open={!!detailFor} onClose={() => setDetailFor(null)} title={t('live.sessionRecord')} wide>
        {detailFor && <SessionSummary sessionId={detailFor} attendance={attendance ?? []} />}
      </Modal>

      {/* Bookings modal */}
      <Modal open={!!bookingsFor} onClose={() => setBookingsFor(null)} title={t('live.attendees')}>
        {!bookings?.length ? (
          <p className="py-6 text-center text-sm text-outline">{t('live.noAttendees')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {bookings.map((b: any) => (
              <li key={b.id} className="flex items-center justify-between py-2.5">
                <span className="font-bold">{b.fullName}</span>
                <span className="text-sm text-outline" dir="ltr">
                  {b.phone ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

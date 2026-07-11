import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Badge, CardGridSkeleton, EmptyState, ErrorNote, Field, Modal, PageHeader } from '../../components/ui';

function when(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function TeacherLivePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [bookingsFor, setBookingsFor] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', description: '', startsAt: '', durationMin: '60', capacity: '', joinUrl: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['teacher-live'],
    queryFn: async () => (await api.get('/teacher/live')).data,
  });

  const create = useMutation({
    mutationFn: async () =>
      (await api.post('/teacher/live', {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        startsAt: new Date(form.startsAt).toISOString(),
        durationMin: Number(form.durationMin) || 60,
        capacity: form.capacity ? Number(form.capacity) : null,
        joinUrl: form.joinUrl.trim() || null,
      })).data,
    onSuccess: () => {
      setOpen(false);
      setForm({ title: '', description: '', startsAt: '', durationMin: '60', capacity: '', joinUrl: '' });
      qc.invalidateQueries({ queryKey: ['teacher-live'] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/teacher/live/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-live'] }),
  });
  const { data: bookings } = useQuery({
    queryKey: ['live-bookings', bookingsFor],
    queryFn: async () => (await api.get(`/teacher/live/${bookingsFor}/bookings`)).data,
    enabled: !!bookingsFor,
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <div className="flex items-center justify-between">
        <PageHeader title={t('live.teacherTitle')} subtitle={t('live.teacherSubtitle')} />
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <span className="material-symbols-outlined">add</span>{t('live.schedule')}
        </button>
      </div>

      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState icon="sensors" title={t('live.teacherEmpty')} hint={t('live.teacherEmptyHint')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((s: any) => {
            const past = new Date(s.startsAt).getTime() + s.durationMin * 60_000 < Date.now();
            return (
              <div key={s.id} className="card flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-heading text-lg font-bold">{s.title}</h3>
                  <Badge tone={past ? 'neutral' : 'teal'}>{past ? t('live.ended') : t('live.upcoming')}</Badge>
                </div>
                {s.description && <p className="text-sm text-on-surface-variant" dir="auto">{s.description}</p>}
                <div className="flex flex-wrap items-center gap-4 text-xs text-outline">
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">event</span>{when(s.startsAt)}</span>
                  <span className="flex items-center gap-1"><span className="material-symbols-outlined text-sm">schedule</span>{t('live.minutes', { count: s.durationMin })}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button className="flex items-center gap-1 text-sm font-bold text-primary hover:underline" onClick={() => setBookingsFor(s.id)}>
                    <span className="material-symbols-outlined text-base">group</span>
                    {t('live.bookedCount', { count: s.bookedCount })}{s.capacity != null ? ` / ${s.capacity}` : ''}
                  </button>
                  <button className="text-error/70 hover:text-error" onClick={() => window.confirm(t('live.cancelConfirm')) && remove.mutate(s.id)}>
                    <span className="material-symbols-outlined text-base">delete</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      <Modal open={open} onClose={() => setOpen(false)} title={t('live.schedule')}>
        <Field label={t('live.fTitle')}>
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('live.fTitlePh')} />
        </Field>
        <Field label={t('live.fDescription')}>
          <textarea className="input min-h-20" dir="auto" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('live.fStartsAt')}>
            <input className="input" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </Field>
          <Field label={t('live.fDuration')}>
            <input className="input" inputMode="numeric" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('live.fCapacity')} hint={t('live.fCapacityHint')}>
            <input className="input" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label={t('live.fJoinUrl')}>
            <input className="input" dir="ltr" value={form.joinUrl} onChange={(e) => setForm({ ...form, joinUrl: e.target.value })} placeholder="https://meet…" />
          </Field>
        </div>
        <ErrorNote error={create.error} />
        <button className="btn-primary mt-2 w-full" disabled={create.isPending || !form.title.trim() || !form.startsAt} onClick={() => create.mutate()}>
          {create.isPending ? t('common.saving') : t('live.publish')}
        </button>
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
                <span className="text-sm text-outline" dir="ltr">{b.phone ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

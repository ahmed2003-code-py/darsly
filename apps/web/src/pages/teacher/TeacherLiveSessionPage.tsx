import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { confirmDelete } from '../../lib/confirm';
import { egp } from '../../lib/format';
import { formatDuration } from '../../lib/liveSessionForm';
import { Badge, ErrorNote, Modal, Spinner } from '../../components/ui';
import LiveSessionForm, { type EditableSession } from './LiveSessionForm';
import SessionSummary from '../live/SessionSummary';

function when(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * One live session, for the teacher who runs it: what it is, who holds a
 * seat, what was sold (the teacher's side only), the one link to share, and
 * what can still change — as the server decides it. Editing is the same form
 * as creating, with the locked fields locked and the reason said.
 */
export default function TeacherLiveSessionPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState(false);
  const [record, setRecord] = useState(false);
  const [copied, setCopied] = useState(false);

  const detail = useQuery({
    queryKey: ['teacher-live-detail', id],
    queryFn: async () => (await api.get(`/teacher/live/${id}`)).data,
    refetchInterval: 30_000,
  });
  const bookings = useQuery({
    queryKey: ['live-bookings', id],
    queryFn: async () => (await api.get(`/teacher/live/${id}/bookings`)).data,
    enabled: people,
  });
  const attendance = useQuery({
    queryKey: ['live-attendance', id],
    queryFn: async () => (await api.get(`/teacher/live/${id}/attendance`)).data,
    enabled: record,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['teacher-live-detail', id] });
    qc.invalidateQueries({ queryKey: ['teacher-live'] });
  };
  const start = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${id}/start`)).data,
    onSuccess: () => navigate(`/live/${id}/meeting`),
  });
  const cancel = useMutation({
    mutationFn: async () => (await api.delete(`/teacher/live/${id}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teacher-live'] });
      navigate('/teacher/live', { replace: true });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="page grid place-items-center py-20">
        <Spinner />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="page">
        <ErrorNote error={detail.error} />
        <Link to="/teacher/live" className="btn-ghost mt-4">
          {t('liveManage.back')}
        </Link>
      </div>
    );
  }

  const { session: s, seats, sales, edit, publicPath } = detail.data;
  const url = publicPath ? `${window.location.origin}${publicPath}` : null;
  const now = Date.now();
  const live = s.status === 'LIVE';
  const ended = s.status === 'ENDED';
  const canStart = !ended && now >= new Date(s.joinOpensAt).getTime();
  const readOnly = edit.state === 'ENDED' || edit.state === 'CANCELLED';

  return (
    <div className="page max-w-4xl">
      <Link
        to="/teacher/live"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
      >
        <span aria-hidden className="material-symbols-outlined text-base rtl:rotate-180">
          arrow_back
        </span>
        {t('liveManage.back')}
      </Link>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold" dir="auto">
              {s.title}
            </h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              {when(s.startsAt)} · {formatDuration(s.durationMin, t)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold tabular-nums ${
                s.accessMode === 'PAID'
                  ? 'bg-primary-fixed text-on-primary-fixed'
                  : 'bg-secondary-container text-on-secondary-container'
              }`}
            >
              {s.accessMode === 'PAID' ? egp(s.priceCents) : t('liveBuy.free')}
            </span>
            <Badge tone={live ? 'error' : ended ? 'neutral' : 'teal'}>
              {t(`liveManage.state.${edit.state}`)}
            </Badge>
          </div>
        </div>
        {s.description && (
          <p className="whitespace-pre-line text-sm text-on-surface-variant">{s.description}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {!ended && (
            <button
              className="btn-primary"
              disabled={!canStart || start.isPending}
              onClick={() => (live ? navigate(`/live/${id}/meeting`) : start.mutate())}
            >
              <span className="material-symbols-outlined text-base">videocam</span>
              {live
                ? t('live.continueMeeting')
                : canStart
                  ? t('live.startMeeting')
                  : t('live.startOpensSoon')}
            </button>
          )}
          {!readOnly && (
            <button className="btn-ghost" onClick={() => setEditing(true)}>
              <span className="material-symbols-outlined text-base">edit</span>
              {t('liveManage.edit')}
            </button>
          )}
          {ended && (
            <button className="btn-ghost" onClick={() => setRecord(true)}>
              <span className="material-symbols-outlined text-base">description</span>
              {t('live.viewSession')}
            </button>
          )}
        </div>
        <ErrorNote error={start.error} />
      </div>

      {/* The one link to share. */}
      <div className="card mt-4">
        <p className="font-heading font-bold">{t('liveManage.link')}</p>
        {url ? (
          <>
            <p className="mt-1 text-sm text-on-surface-variant">
              {s.accessMode === 'PAID'
                ? t('liveManage.linkHintPaid')
                : t('liveManage.linkHintFree')}
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                className="input flex-1 text-xs"
                dir="ltr"
                readOnly
                value={url}
                aria-label={t('liveManage.link')}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(url).then(() => setCopied(true));
                }}
              >
                <span className="material-symbols-outlined text-base">
                  {copied ? 'check' : 'content_copy'}
                </span>
                {copied ? t('liveCommerce.linkCopied') : t('liveManage.copy')}
              </button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-on-surface-variant">{t('liveManage.groupNoLink')}</p>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card">
          <p className="font-heading font-bold">{t('liveManage.seats')}</p>
          <p className="mt-2 font-heading text-3xl font-bold tabular-nums">
            {seats.taken}
            {seats.capacity != null && (
              <span className="text-lg text-outline"> / {seats.capacity}</span>
            )}
          </p>
          <p className="mt-1 text-xs text-outline">
            {t('liveManage.seatsBreakdown', {
              students: seats.studentBookings,
              guests: seats.guestSeats,
            })}
          </p>
          <button
            className="mt-3 text-sm font-bold text-primary hover:underline"
            onClick={() => setPeople(true)}
          >
            {t('liveManage.viewPeople')}
          </button>
        </div>
        {sales && (
          <div className="card">
            <p className="font-heading font-bold">{t('liveManage.sales')}</p>
            <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-on-surface-variant">{t('liveManage.salesConfirmed')}</dt>
              <dd className="text-end tabular-nums">{sales.confirmed}</dd>
              <dt className="text-on-surface-variant">{t('liveManage.salesAwaiting')}</dt>
              <dd className="text-end tabular-nums">{sales.awaitingPayment}</dd>
              <dt className="text-on-surface-variant">{t('liveManage.salesRefunded')}</dt>
              <dd className="text-end tabular-nums">{sales.refunded}</dd>
              <dt className="font-semibold text-primary-text">{t('liveManage.salesEarnings')}</dt>
              <dd className="text-end font-semibold text-primary-text tabular-nums">
                {egp(sales.teacherCents)}
              </dd>
            </dl>
            <p className="mt-2 text-xs text-outline">{t('liveManage.earningsHeld')}</p>
          </div>
        )}
      </div>

      <div className="card mt-4">
        <p className="font-heading font-bold">{t('liveManage.editRules')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {t(
            `liveManage.rules.${edit.state}${edit.state === 'SCHEDULED' && edit.committed ? '_COMMITTED' : ''}`,
          )}
        </p>
        {!readOnly && !live && (
          <button
            className="mt-3 text-sm font-bold text-error hover:underline"
            disabled={cancel.isPending}
            onClick={async () => {
              if (
                await confirmDelete({
                  kind: 'cancel',
                  message:
                    s.accessMode === 'PAID'
                      ? t('liveManage.cancelPaidConfirm')
                      : t('live.cancelConfirm'),
                })
              )
                cancel.mutate();
            }}
          >
            {t('liveManage.cancelSession')}
          </button>
        )}
        <ErrorNote error={cancel.error} />
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title={t('liveManage.edit')}>
        {editing && (
          <LiveSessionForm
            session={s as EditableSession}
            editable={edit.editable}
            committed={edit.committed}
            onCancel={() => setEditing(false)}
            onCreated={() => {
              setEditing(false);
              refresh();
            }}
          />
        )}
      </Modal>

      <Modal open={people} onClose={() => setPeople(false)} title={t('live.attendees')}>
        {!bookings.data?.length ? (
          <p className="py-6 text-center text-sm text-outline">{t('live.noAttendees')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {bookings.data.map((b: any) => (
              <li key={b.id} className="flex items-center justify-between py-2.5">
                <span className="font-bold">
                  {b.fullName}
                  {b.guest && (
                    <span className="ms-2 text-xs font-normal text-outline">
                      ({t('liveManage.guest')})
                    </span>
                  )}
                </span>
                <span className="text-sm text-outline" dir="ltr">
                  {b.phone ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal open={record} onClose={() => setRecord(false)} title={t('live.sessionRecord')} wide>
        {record && <SessionSummary sessionId={id} attendance={attendance.data ?? []} />}
      </Modal>
    </div>
  );
}

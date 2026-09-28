import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ErrorNote, Skeleton } from '../../components/ui';
import { backoffInterval } from '../../lib/livePolling';
import LiveContentSection from './LiveContentSection';
import LiveReplayPlayer from './LiveReplayPlayer';
import {
  isStudyNotes,
  LegacySummaryView,
  Status,
  StudyNotesView,
  TranscriptViewer,
  type Segment,
  type Summary,
} from '../../components/live/ClassNotes';

/**
 * What a lesson left behind: its recording, its words, its summary, who came
 * and what was said in the chat — each its own section with its own state,
 * because they are separate processes. A summary waiting on a transcript is
 * waiting, not failed; a recording being packaged says which stage it is in,
 * never a raw status.
 *
 * The recording, the transcript and the summary are each shared on their own
 * (the teacher picks, per section). The same component serves both sides of
 * the class; the server has already decided what each may read.
 */

type RecStage = 'REQUESTED' | 'CAPTURING' | 'FINALIZING' | 'PROCESSING' | 'READY' | 'FAILED';
type Visibility = 'PRIVATE' | 'STUDENTS';
type Attendee = { id: string; fullName: string; role: string; durationSeconds: number };
const IN_PROGRESS_REC: RecStage[] = ['REQUESTED', 'CAPTURING', 'FINALIZING', 'PROCESSING'];

function Block({
  id,
  icon,
  title,
  aside,
  children,
}: {
  id?: string;
  icon: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 py-4 first:pt-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span aria-hidden className="material-symbols-outlined text-[20px] text-on-surface-variant">
          {icon}
        </span>
        <h3 className="flex-1 font-heading text-base font-bold">{title}</h3>
        {aside}
      </div>
      <div className="ps-7">{children}</div>
    </section>
  );
}

function minutesOf(totalSeconds: number, t: (k: string, o?: any) => string) {
  const m = Math.round(totalSeconds / 60);
  return m < 1 ? t('summary.underMinute') : t('live.minutes', { count: m });
}

/** The teacher's per-section sharing choice. */
function VisibilityPicker({
  sessionId,
  resource,
  value,
}: {
  sessionId: string;
  resource: 'recording' | 'transcript' | 'summary';
  value: Visibility;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: async (v: Visibility) =>
      (await api.patch(`/teacher/live/${sessionId}/visibility`, { [resource]: v })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  return (
    <label className="flex items-center gap-1.5 text-xs text-outline">
      <span aria-hidden className="material-symbols-outlined text-[16px]">
        {value === 'STUDENTS' ? 'group' : 'lock'}
      </span>
      <span className="sr-only">{t('record.visibility.label')}</span>
      <select
        className="rounded-lg border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold text-on-surface"
        value={set.isPending ? (set.variables as Visibility) : value}
        disabled={set.isPending}
        onChange={(e) => set.mutate(e.target.value as Visibility)}
        aria-label={t('record.visibility.label')}
      >
        <option value="PRIVATE">{t('record.visibility.PRIVATE')}</option>
        <option value="STUDENTS">{t('record.visibility.STUDENTS')}</option>
      </select>
    </label>
  );
}

function RecordingSection({
  sessionId,
  teacher,
  recording,
}: {
  sessionId: string;
  teacher: boolean;
  recording: {
    status: string;
    stage: RecStage | null;
    failure: 'NOT_STARTED' | 'NOTHING_RECORDED' | 'PROCESSING_FAILED' | null;
    available: boolean;
    playable?: boolean;
    visibility?: Visibility;
    durationSeconds?: number | null;
  };
}) {
  const { t } = useTranslation();
  const [watching, setWatching] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  // Daily's own recordings: a short-lived provider link.
  const open = useMutation({
    mutationFn: async () => (await api.get(`/live/${sessionId}/recording`)).data,
    onSuccess: (d) => setUrl(d.url),
  });
  const stage = recording.stage;
  // Only a finished recording has a length worth stating.
  const length = stage === 'READY' && recording.durationSeconds ? minutesOf(recording.durationSeconds, t) : null;

  let body: ReactNode;
  if (!stage) body = <p className="text-sm text-outline">{t('record.rec.none')}</p>;
  else if (stage === 'READY' && recording.playable)
    body = watching ? (
      <LiveReplayPlayer sessionId={sessionId} />
    ) : (
      <button className="btn-primary" onClick={() => setWatching(true)}>
        <span aria-hidden className="material-symbols-outlined text-[20px]">play_arrow</span>
        {t('record.rec.watch')}
      </button>
    );
  else if (stage === 'READY' && recording.available)
    body = url ? (
      <video src={url} controls playsInline className="w-full rounded-xl bg-black" />
    ) : (
      <button className="btn-primary" disabled={open.isPending} onClick={() => open.mutate()}>
        <span aria-hidden className="material-symbols-outlined text-[20px]">play_arrow</span>
        {open.isPending ? t('common.loading') : t('summary.watch')}
      </button>
    );
  else if (stage === 'READY')
    body = <Status tone="good" title={t('record.rec.READY')} hint={t('record.rec.readyHint')} />;
  else if (stage === 'FAILED')
    body = (
      <Status
        tone="bad"
        title={t('record.rec.FAILED')}
        hint={t(`record.rec.failure.${recording.failure ?? 'PROCESSING_FAILED'}`)}
      />
    );
  else
    body = (
      <Status
        busy
        title={t(`record.rec.${stage}`)}
        hint={stage === 'PROCESSING' || stage === 'FINALIZING' ? t('record.rec.processingHint') : undefined}
      />
    );

  return (
    <Block
      id="rec-recording"
      icon="smart_display"
      title={t('summary.recording')}
      aside={
        <>
          {length && <span className="text-xs text-outline">{length}</span>}
          {teacher && recording.visibility && stage && stage !== 'FAILED' && (
            <VisibilityPicker sessionId={sessionId} resource="recording" value={recording.visibility} />
          )}
        </>
      }
    >
      {body}
      {open.isError && <p className="mt-2 text-sm text-error">{t('record.rec.openFailed')}</p>}
    </Block>
  );
}

function TranscriptSection({
  sessionId,
  teacher,
  transcript,
}: {
  sessionId: string;
  teacher: boolean;
  transcript: {
    stage: string;
    reason: string | null;
    partial?: boolean;
    canRetry?: boolean;
    visibility?: Visibility;
    segments?: Segment[];
  };
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/transcript/retry`)).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  const s = transcript.stage;
  const retryButton =
    teacher && transcript.canRetry ? (
      <div className="mt-2 space-y-1">
        <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">refresh</span>
          {t('record.transcript.retry')}
        </button>
        <ErrorNote error={retry.error} />
      </div>
    ) : null;
  let body: ReactNode;
  if ((s === 'READY' || s === 'PARTIAL') && transcript.segments?.length)
    body = (
      <>
        <TranscriptViewer segments={transcript.segments} partial={s === 'PARTIAL' || !!transcript.partial} />
        {retryButton}
      </>
    );
  else if (s === 'READY') body = <Status tone="good" title={t('record.transcript.READY')} />;
  else if (s === 'PARTIAL') body = <Status title={t('record.transcript.PARTIAL')} hint={t('record.transcript.partial')} />;
  else if (s === 'UNAVAILABLE' && transcript.reason === 'TRANSCRIPTION_OFF')
    body = <Status title={t('record.transcript.OFF')} />;
  else if (s === 'UNAVAILABLE')
    body = (
      <Status
        title={t('record.transcript.UNAVAILABLE')}
        hint={transcript.reason ? t(`record.transcript.reason.${transcript.reason}`) : undefined}
      />
    );
  else if (s === 'FAILED')
    body = (
      <>
        <Status tone="bad" title={t('record.transcript.FAILED')} hint={t('record.transcript.failedHint')} />
        {retryButton}
      </>
    );
  else if (s === 'AT_PROVIDER') body = <Status title={t('record.transcript.AT_PROVIDER')} />;
  else if (s === 'WAITING_FOR_CLASS_END') body = <Status title={t('record.transcript.WAITING_FOR_CLASS_END')} />;
  else body = <Status busy title={t(`record.transcript.${s}`)} />;
  return (
    <Block
      id="rec-transcript"
      icon="subject"
      title={t('record.transcript.title')}
      aside={
        teacher && transcript.visibility && (s === 'READY' || s === 'PARTIAL') ? (
          <VisibilityPicker sessionId={sessionId} resource="transcript" value={transcript.visibility} />
        ) : null
      }
    >
      {body}
    </Block>
  );
}

/**
 * What was said in the class chat — kept for everyone who was in it, the
 * teacher and the students alike, so a link or a question asked in passing is
 * still there after the class.
 */
function ChatSection({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const chat = useQuery({
    queryKey: ['live-chat-record', sessionId],
    queryFn: async () =>
      (await api.get(`/live/${sessionId}/chat`)).data as {
        id: string;
        body: string;
        senderName: string;
        senderRole: string;
        createdAt: string;
      }[],
  });
  const msgs = chat.data ?? [];
  const shown = open ? msgs : msgs.slice(-5);
  return (
    <Block
      id="rec-chat"
      icon="forum"
      title={t('record.chat.title')}
      aside={msgs.length ? <span className="text-xs text-outline">{t('record.chat.count', { count: msgs.length })}</span> : null}
    >
      {chat.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : !msgs.length ? (
        <p className="text-sm text-outline">{t('record.chat.empty')}</p>
      ) : (
        <>
          {!open && msgs.length > 5 && (
            <button className="mb-2 text-xs font-semibold text-primary-text hover:underline" onClick={() => setOpen(true)}>
              {t('record.chat.showAll', { count: msgs.length })}
            </button>
          )}
          <ul className="space-y-2.5">
            {shown.map((m) => (
              <li key={m.id}>
                <p className="text-xs text-outline">
                  <span className="font-semibold text-on-surface-variant">{m.senderName}</span>
                  {m.senderRole === 'TEACHER' && ` · ${t('meeting.teacherBadge')}`}
                  {' · '}
                  {new Date(m.createdAt).toLocaleTimeString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm" dir="auto">
                  {m.body}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

export default function SessionSummary({
  sessionId,
  attendance,
}: {
  sessionId: string;
  /** The teacher's view passes who came; a student's does not. */
  attendance?: Attendee[];
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();

  // When the current wait began: quick polling first, backing off, then
  // stopping (lib/livePolling) — and none at all once everything has settled.
  const movingSince = useRef<number | null>(null);
  const detail = useQuery({
    queryKey: ['live-detail', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/detail`)).data,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      const moving =
        IN_PROGRESS_REC.includes(d.recording?.stage) ||
        d.summary?.stage === 'GENERATING' ||
        d.transcript?.stage === 'TRANSCRIBING' ||
        d.transcript?.stage === 'WAITING_FOR_CLASS_END';
      if (!moving) {
        movingSince.current = null;
        return false;
      }
      movingSince.current ??= Date.now();
      return backoffInterval(movingSince.current);
    },
  });

  const generate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  // A new summary from the current transcript (never re-transcribes). One at a time.
  const regenerating = useRef(false);
  const regenerate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary/regenerate`)).data,
    onSettled: () => {
      regenerating.current = false;
      qc.invalidateQueries({ queryKey: ['live-detail', sessionId] });
    },
  });

  if (detail.isLoading)
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (detail.isError) return <ErrorNote error={detail.error} />;

  const d = detail.data;
  const isTeacher = d.role === 'TEACHER';
  const sStage: string = d.summary.stage ?? d.summary.status;
  const data: Summary | null = d.summary.data;
  const students = attendance?.filter((a) => a.role !== 'TEACHER') ?? [];
  const nav: { id: string; label: string }[] = [
    { id: 'rec-recording', label: t('record.nav.recording') },
    ...(d.transcript ? [{ id: 'rec-transcript', label: t('record.nav.transcript') }] : []),
    { id: 'rec-summary', label: t('record.nav.summary') },
    ...(attendance ? [{ id: 'rec-attendance', label: t('record.nav.attendance') }] : []),
    { id: 'rec-chat', label: t('record.nav.chat') },
  ];

  return (
    <div className="divide-y divide-outline-variant/60">
      {/* Overview */}
      <div className="space-y-3 pb-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-[18px]">event</span>
            {new Date(d.startsAt).toLocaleString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-[18px]">timer</span>
            {d.actualDurationSec != null
              ? t('record.actualDuration', { duration: minutesOf(d.actualDurationSec, t) })
              : t('live.minutes', { count: d.durationMin })}
          </span>
          {attendance && (
            <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
              <span aria-hidden className="material-symbols-outlined text-[18px]">group</span>
              {t('record.attendedCount', { count: students.length })}
            </span>
          )}
        </div>
        <nav aria-label={t('record.nav.overview')} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {nav.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(n.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="shrink-0 rounded-full bg-surface-container px-3 py-1 text-xs font-semibold text-on-surface-variant hover:bg-surface-container-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {n.label}
            </a>
          ))}
        </nav>
      </div>

      <RecordingSection sessionId={sessionId} teacher={isTeacher} recording={d.recording} />

      {/* The class, reused as course content — teacher side, once it has ended
          and its recording plays. */}
      {isTeacher && d.status === 'ENDED' && d.recording?.playable && (
        <LiveContentSection sessionId={sessionId} sessionTitle={d.title} />
      )}

      {d.transcript && <TranscriptSection sessionId={sessionId} teacher={isTeacher} transcript={d.transcript} />}

      <Block
        id="rec-summary"
        icon="auto_awesome"
        title={t('summary.title')}
        aside={
          isTeacher && sStage === 'READY' && d.summary.visibility ? (
            <VisibilityPicker sessionId={sessionId} resource="summary" value={d.summary.visibility} />
          ) : null
        }
      >
        {sStage === 'READY' && data ? (
          <div className="space-y-3">
            <Status tone="good" title={t('summary.ready')} />
            {d.summary.partial && <Status title={t('summary.partialTitle')} hint={t('summary.partial')} />}
            {d.summary.stale && <Status title={t('summary.stale')} />}
            {isStudyNotes(data) ? <StudyNotesView n={data} /> : <LegacySummaryView data={data} />}
            {isTeacher && d.summary.canRegenerate && (
              <div className="space-y-1 pt-1">
                <button
                  type="button"
                  className="btn-secondary !py-1.5 text-sm"
                  disabled={regenerate.isPending}
                  onClick={() => {
                    if (regenerating.current) return;
                    regenerating.current = true;
                    regenerate.mutate();
                  }}
                >
                  <span aria-hidden className="material-symbols-outlined text-[18px]">autorenew</span>
                  {regenerate.isPending ? t('common.saving') : t('summary.regenerate')}
                </button>
                <ErrorNote error={regenerate.error} />
              </div>
            )}
          </div>
        ) : sStage === 'GENERATING' || sStage === 'PROCESSING' ? (
          <Status busy title={t('record.summary.GENERATING')} />
        ) : sStage === 'WAITING_FOR_TRANSCRIPT' ? (
          <Status title={t('record.summary.WAITING_FOR_TRANSCRIPT')} />
        ) : sStage === 'UNAVAILABLE' ? (
          <Status title={t('record.summary.UNAVAILABLE')} />
        ) : sStage === 'FAILED' ? (
          <div className="space-y-2">
            <Status
              tone="bad"
              title={t('record.summary.FAILED')}
              hint={
                d.summary.error === 'TRANSCRIPT_PENDING' || d.summary.error === 'PROVIDER_UNREACHABLE'
                  ? t('summary.transcriptPending')
                  : undefined
              }
            />
            {isTeacher && d.summary.canGenerate && (
              <button className="btn-secondary" disabled={generate.isPending} onClick={() => generate.mutate()}>
                {t('summary.retry')}
              </button>
            )}
          </div>
        ) : isTeacher ? (
          <div className="space-y-2">
            <p className="text-sm text-outline">{t('summary.notYetHint')}</p>
            <button className="btn-primary" disabled={generate.isPending || !d.summary.canGenerate} onClick={() => generate.mutate()}>
              <span aria-hidden className="material-symbols-outlined text-[18px]">auto_awesome</span>
              {generate.isPending ? t('common.saving') : t('summary.generate')}
            </button>
          </div>
        ) : (
          <p className="text-sm text-outline">{t('summary.notShared')}</p>
        )}
        {isTeacher && <ErrorNote error={generate.error} />}
      </Block>

      {attendance && (
        <Block id="rec-attendance" icon="how_to_reg" title={t('live.attendance')}>
          {!attendance.length ? (
            <p className="text-sm text-outline">{t('live.noAttendance')}</p>
          ) : (
            <ul className="divide-y divide-outline-variant/40">
              {attendance.map((a) => (
                <li key={a.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="auto">
                    {a.fullName}
                  </span>
                  {a.role === 'TEACHER' && (
                    <span className="rounded-full bg-primary-fixed px-2 py-0.5 text-[10px] font-bold text-on-primary-fixed">
                      {t('meeting.teacherBadge')}
                    </span>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-outline">
                    {t('live.minutes', { count: Math.max(1, Math.round(a.durationSeconds / 60)) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      )}

      <ChatSection sessionId={sessionId} />
    </div>
  );
}

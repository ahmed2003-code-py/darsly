import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ErrorNote, Skeleton } from '../../components/ui';
import LiveReplayPlayer from './LiveReplayPlayer';

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

interface Summary {
  summary: string;
  topics: string[];
  keyPoints: string[];
  questionsAndAnswers: { question: string; answer: string }[];
  actionItems: string[];
}

type RecStage = 'REQUESTED' | 'CAPTURING' | 'FINALIZING' | 'PROCESSING' | 'READY' | 'FAILED';
type Visibility = 'PRIVATE' | 'STUDENTS';
type Attendee = { id: string; fullName: string; role: string; durationSeconds: number };
type Segment = { startSec: number | null; durationSec: number | null; text: string };

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

/** One state line: an icon, what is happening, and optionally why. */
function Status({
  tone = 'neutral',
  busy,
  title,
  hint,
}: {
  tone?: 'neutral' | 'good' | 'bad';
  busy?: boolean;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2" role={busy ? 'status' : undefined}>
      {busy ? (
        <span
          aria-hidden
          className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin"
        />
      ) : (
        <span
          aria-hidden
          className={`material-symbols-outlined mt-px text-[18px] ${
            tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-error' : 'text-outline'
          }`}
        >
          {tone === 'good' ? 'check_circle' : tone === 'bad' ? 'error' : 'info'}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {hint && <p className="mt-0.5 text-sm text-outline">{hint}</p>}
      </div>
    </div>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-outline">{empty}</p>;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed" dir="auto">
          <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function minutesOf(totalSeconds: number, t: (k: string, o?: any) => string) {
  const m = Math.round(totalSeconds / 60);
  return m < 1 ? t('summary.underMinute') : t('live.minutes', { count: m });
}

/** 75 → "1:15", 3725 → "1:02:05". */
function clock(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** The transcript, readable: by time, searchable, copyable. No speaker names — none are known. */
function TranscriptViewer({ segments, partial }: { segments: Segment[]; partial: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const query = q.trim();
  const shown = useMemo(
    () => (query ? segments.filter((s) => s.text.toLowerCase().includes(query.toLowerCase())) : segments),
    [segments, query],
  );
  const visible = query || all ? shown : shown.slice(0, 3);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(segments.map((s) => s.text).join('\n\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused */
    }
  };
  return (
    <div className="space-y-3">
      {partial && <Status title={t('record.transcript.partial')} />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden
            className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[18px] text-outline"
          >
            search
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('record.transcript.search')}
            aria-label={t('record.transcript.search')}
            className="w-full rounded-xl border border-outline-variant bg-surface py-2 pe-3 ps-9 text-sm"
          />
        </div>
        <button type="button" className="btn-secondary !py-2 text-sm" onClick={copy}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? t('record.transcript.copied') : t('record.transcript.copy')}
        </button>
      </div>
      {query && (
        <p className="text-xs text-outline" role="status">
          {t('record.transcript.matches', { count: shown.length })}
        </p>
      )}
      <ol className="space-y-3">
        {visible.map((s, i) => (
          <li key={i} className="flex gap-3">
            {s.startSec != null && (
              <span dir="ltr" className="mt-0.5 w-12 shrink-0 text-xs tabular-nums text-outline">
                {clock(s.startSec)}
              </span>
            )}
            <p dir="auto" className="min-w-0 flex-1 whitespace-pre-wrap text-[15px] leading-8 text-on-surface">
              <Highlight text={s.text} q={query} />
            </p>
          </li>
        ))}
      </ol>
      {!query && shown.length > 3 && (
        <button
          type="button"
          className="text-xs font-semibold text-primary-text hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? t('record.transcript.showLess') : t('record.transcript.showAll')}
        </button>
      )}
    </div>
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
    visibility?: Visibility;
    segments?: Segment[];
  };
}) {
  const { t } = useTranslation();
  const s = transcript.stage;
  let body: ReactNode;
  if (s === 'READY' && transcript.segments?.length)
    body = <TranscriptViewer segments={transcript.segments} partial={!!transcript.partial} />;
  else if (s === 'READY') body = <Status tone="good" title={t('record.transcript.READY')} />;
  else if (s === 'UNAVAILABLE' && transcript.reason === 'TRANSCRIPTION_OFF')
    body = <Status title={t('record.transcript.OFF')} />;
  else if (s === 'UNAVAILABLE')
    body = (
      <Status
        title={t('record.transcript.UNAVAILABLE')}
        hint={transcript.reason ? t(`record.transcript.reason.${transcript.reason}`) : undefined}
      />
    );
  else if (s === 'FAILED') body = <Status tone="bad" title={t('record.transcript.FAILED')} />;
  else if (s === 'AT_PROVIDER') body = <Status title={t('record.transcript.AT_PROVIDER')} />;
  else if (s === 'WAITING_FOR_CLASS_END') body = <Status title={t('record.transcript.WAITING_FOR_CLASS_END')} />;
  else body = <Status busy title={t(`record.transcript.${s}`)} />;
  return (
    <Block
      id="rec-transcript"
      icon="subject"
      title={t('record.transcript.title')}
      aside={
        teacher && transcript.visibility && s === 'READY' ? (
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

  const detail = useQuery({
    queryKey: ['live-detail', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/detail`)).data,
    // While anything is still moving, the record catches up on its own.
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      const moving =
        IN_PROGRESS_REC.includes(d.recording?.stage) ||
        d.summary?.stage === 'GENERATING' ||
        d.transcript?.stage === 'TRANSCRIBING' ||
        d.transcript?.stage === 'WAITING_FOR_CLASS_END';
      return moving ? 5000 : false;
    },
  });

  const generate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
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
          <div dir="auto" className="space-y-4">
            <p className="text-sm leading-relaxed">{data.summary}</p>
            {data.topics.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {data.topics.map((tp, i) => (
                  <span key={i} className="rounded-full bg-primary-fixed px-2.5 py-1 text-xs font-semibold text-on-primary-fixed">
                    {tp}
                  </span>
                ))}
              </div>
            )}
            <div>
              <h4 className="mb-1 text-sm font-bold">{t('summary.keyPoints')}</h4>
              <Bullets items={data.keyPoints} empty={t('summary.noneKeyPoints')} />
            </div>
            <div>
              <h4 className="mb-1 text-sm font-bold">{t('summary.qa')}</h4>
              {data.questionsAndAnswers.length ? (
                <dl className="space-y-2">
                  {data.questionsAndAnswers.map((qa, i) => (
                    <div key={i}>
                      <dt className="text-sm font-semibold">{qa.question}</dt>
                      <dd className="text-sm text-on-surface-variant">{qa.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-outline">{t('summary.noneQa')}</p>
              )}
            </div>
            <div>
              <h4 className="mb-1 text-sm font-bold">{t('summary.homework')}</h4>
              <Bullets items={data.actionItems} empty={t('summary.noneHomework')} />
            </div>
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

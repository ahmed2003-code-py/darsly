import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ErrorNote, Skeleton } from '../../components/ui';

/**
 * What a lesson left behind: its recording, its words, its summary, and who
 * came — each its own section with its own state, because they are separate
 * processes. A summary waiting on a transcript is waiting, not failed; a
 * recording being packaged says which stage it is in, never a raw status.
 *
 * The same component serves both sides of the class; the server has already
 * decided what each may read.
 */

interface Summary {
  summary: string;
  topics: string[];
  keyPoints: string[];
  questionsAndAnswers: { question: string; answer: string }[];
  actionItems: string[];
}

type RecStage = 'REQUESTED' | 'CAPTURING' | 'FINALIZING' | 'PROCESSING' | 'READY' | 'FAILED';
type Attendee = { id: string; fullName: string; role: string; durationSeconds: number };

const IN_PROGRESS_REC: RecStage[] = ['REQUESTED', 'CAPTURING', 'FINALIZING', 'PROCESSING'];

function Block({
  icon,
  title,
  aside,
  children,
}: {
  icon: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="py-4 first:pt-0 last:pb-0">
      <div className="mb-2 flex items-center gap-2">
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

function RecordingSection({
  sessionId,
  recording,
}: {
  sessionId: string;
  recording: {
    status: string;
    stage: RecStage | null;
    failure: 'NOT_STARTED' | 'NOTHING_RECORDED' | 'PROCESSING_FAILED' | null;
    available: boolean;
    durationSeconds?: number | null;
  };
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: async () => (await api.get(`/live/${sessionId}/recording`)).data,
    onSuccess: (d) => setUrl(d.url),
  });
  const stage = recording.stage;
  const length = recording.durationSeconds ? minutesOf(recording.durationSeconds, t) : null;

  let body: ReactNode;
  if (!stage) body = <p className="text-sm text-outline">{t('record.rec.none')}</p>;
  else if (stage === 'READY')
    body = recording.available ? (
      url ? (
        <video src={url} controls playsInline className="w-full rounded-xl bg-black" />
      ) : (
        <button className="btn-primary" disabled={open.isPending} onClick={() => open.mutate()}>
          <span aria-hidden className="material-symbols-outlined text-[20px]">play_arrow</span>
          {open.isPending ? t('common.loading') : t('summary.watch')}
        </button>
      )
    ) : (
      <Status tone="good" title={t('record.rec.READY')} hint={t('record.rec.readyHint')} />
    );
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
      icon="smart_display"
      title={t('summary.recording')}
      aside={length ? <span className="text-xs text-outline">{length}</span> : null}
    >
      {body}
      {open.isError && <p className="mt-2 text-sm text-error">{t('record.rec.openFailed')}</p>}
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
        d.transcript?.stage === 'WAITING_FOR_RECORDING';
      return moving ? 5000 : false;
    },
  });

  const generate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  const share = useMutation({
    mutationFn: async (visible: boolean) =>
      (await api.patch(`/teacher/live/${sessionId}/summary/visibility`, { visible })).data,
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

  return (
    <div className="divide-y divide-outline-variant/60">
      {/* Overview */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 pb-4 text-sm">
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
          {t('live.minutes', { count: d.durationMin })}
        </span>
        {attendance && (
          <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-[18px]">group</span>
            {t('record.attendedCount', { count: students.length })}
          </span>
        )}
      </div>

      <RecordingSection sessionId={sessionId} recording={d.recording} />

      {isTeacher && d.transcript && (
        <Block icon="subject" title={t('record.transcript.title')}>
          {d.transcript.stage === 'READY' ? (
            <Status tone="good" title={t('record.transcript.READY')} />
          ) : d.transcript.stage === 'UNAVAILABLE' ? (
            <Status title={t('record.transcript.UNAVAILABLE')} hint={t(`record.transcript.reason.${d.transcript.reason}`)} />
          ) : d.transcript.stage === 'FAILED' ? (
            <Status tone="bad" title={t('record.transcript.FAILED')} />
          ) : d.transcript.stage === 'AT_PROVIDER' ? (
            <Status title={t('record.transcript.AT_PROVIDER')} />
          ) : (
            <Status busy title={t(`record.transcript.${d.transcript.stage}`)} />
          )}
        </Block>
      )}

      <Block
        icon="auto_awesome"
        title={t('summary.title')}
        aside={
          isTeacher && sStage === 'READY' ? (
            <label className="flex items-center gap-2 text-xs font-semibold">
              <input
                type="checkbox"
                className="accent-primary"
                checked={d.summary.sharedWithStudents}
                onChange={(e) => share.mutate(e.target.checked)}
              />
              {t('summary.share')}
            </label>
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

      <ChatSection sessionId={sessionId} />

      {attendance && (
        <Block icon="how_to_reg" title={t('live.attendance')}>
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
    </div>
  );
}

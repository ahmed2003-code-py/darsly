import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { ErrorNote, Modal, Skeleton } from '../../components/ui';
import { backoffInterval } from '../../lib/livePolling';
import {
  groupMessages,
  initialOf,
  studentsByAttention,
  type ArchiveMessage,
  type AttendanceReport,
  type AttendanceRow,
} from '../../lib/liveArchive';
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
 * What a finished class left behind, as one calm page: a line of facts, the
 * recording, then compact cards — the class's content (summary and
 * transcript), attendance, and the chat. Each card previews; the whole of it
 * opens in one sheet (beside the page on a wide screen, the whole screen on a
 * phone), loaded only then. Never a dialog inside a dialog.
 *
 * Each process keeps its own state: a summary waiting on its transcript is
 * waiting, not failed; a recording being packaged says which stage it is in.
 * The server has already decided what this reader may see.
 */

type RecStage = 'REQUESTED' | 'CAPTURING' | 'FINALIZING' | 'PROCESSING' | 'READY' | 'FAILED';
type Visibility = 'PRIVATE' | 'STUDENTS';
const IN_PROGRESS_REC: RecStage[] = ['REQUESTED', 'CAPTURING', 'FINALIZING', 'PROCESSING'];
const CHAT_PAGE = 50;
type T = (k: string, o?: Record<string, unknown>) => string;

function minutesOf(totalSeconds: number, t: T) {
  const m = Math.round(totalSeconds / 60);
  return m < 1 ? t('summary.underMinute') : t('live.minutes', { count: m });
}
const timeOf = (iso: string, lang: string) =>
  new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

function Card({
  id,
  icon,
  title,
  aside,
  children,
  className = '',
}: {
  id?: string;
  icon: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card scroll-mt-4 p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span aria-hidden className="material-symbols-outlined text-[20px] text-on-surface-variant">
          {icon}
        </span>
        <h2 className="min-w-0 flex-1 font-heading text-base font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function OpenFull({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onClick}
    >
      {children}
      <span aria-hidden className="material-symbols-outlined text-[18px] rtl:rotate-180">
        chevron_right
      </span>
    </button>
  );
}

/** The teacher's per-part sharing choice. */
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

// ── Recording ──────────────────────────────────────────────────────────────

function RecordingCard({
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
  const length =
    stage === 'READY' && recording.durationSeconds ? minutesOf(recording.durationSeconds, t) : null;

  let body: ReactNode;
  if (!stage) body = <p className="text-sm text-outline">{t('record.rec.none')}</p>;
  else if (stage === 'READY' && recording.playable)
    body = watching ? (
      <LiveReplayPlayer sessionId={sessionId} />
    ) : (
      // A poster, not a player: the player (and its key exchange) loads on tap.
      <button
        type="button"
        onClick={() => setWatching(true)}
        className="group grid aspect-video w-full place-items-center rounded-2xl bg-gradient-to-br from-inverse-surface to-zinc-800 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={t('record.rec.watch')}
      >
        <span className="flex flex-col items-center gap-2">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-white/15 transition group-hover:scale-105 group-hover:bg-white/25">
            <span aria-hidden className="material-symbols-outlined text-[40px]">
              play_arrow
            </span>
          </span>
          <span className="text-sm font-semibold">{t('record.rec.watch')}</span>
        </span>
      </button>
    );
  else if (stage === 'READY' && recording.available)
    body = url ? (
      <video src={url} controls playsInline className="w-full rounded-xl bg-black" />
    ) : (
      <button className="btn-primary" disabled={open.isPending} onClick={() => open.mutate()}>
        <span aria-hidden className="material-symbols-outlined text-[20px]">
          play_arrow
        </span>
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
    <Card
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
    </Card>
  );
}

// ── Content: summary and transcript ────────────────────────────────────────

interface TranscriptView {
  stage: string;
  reason: string | null;
  partial?: boolean;
  canRetry?: boolean;
  progress?: { done: number; total: number };
  visibility?: Visibility;
  segments?: Segment[];
  segmentCount?: number;
}

function SummaryPane({ sessionId, d, teacher }: { sessionId: string; d: any; teacher: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [full, setFull] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] });
  const generate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary`)).data,
    onSuccess: refresh,
  });
  // A new summary from the current transcript (never re-transcribes). One at a time.
  const regenerating = useRef(false);
  const regenerate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary/regenerate`)).data,
    onSettled: () => {
      regenerating.current = false;
      refresh();
    },
  });
  const stage: string = d.summary.stage ?? d.summary.status;
  const data: Summary | null = d.summary.data;

  if (stage === 'READY' && data) {
    const quick = isStudyNotes(data) ? data.quickSummary : data.summary;
    const points = (isStudyNotes(data) ? data.keyPoints.map((k) => k.text) : data.keyPoints).slice(0, 3);
    return (
      <div className="space-y-3">
        {d.summary.partial && <Status title={t('summary.partialTitle')} hint={t('summary.partial')} />}
        {d.summary.stale && <Status title={t('summary.stale')} />}
        <div dir="auto" className="space-y-2">
          {quick && <p className="line-clamp-4 text-sm leading-7">{quick}</p>}
          {points.length > 0 && (
            <ul className="space-y-1">
              {points.map((p, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                  <span className="line-clamp-2">{p}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <OpenFull onClick={() => setFull(true)}>{t('archive.summaryFull')}</OpenFull>
        <Modal variant="sheet" open={full} onClose={() => setFull(false)} title={t('summary.title')}>
          {full && (
            <div className="space-y-4">
              {d.summary.partial && <Status title={t('summary.partialTitle')} hint={t('summary.partial')} />}
              {isStudyNotes(data) ? <StudyNotesView n={data} /> : <LegacySummaryView data={data} />}
              {teacher && d.summary.canRegenerate && (
                <div className="space-y-1 border-t border-outline-variant/60 pt-3">
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
                    <span aria-hidden className="material-symbols-outlined text-[18px]">
                      autorenew
                    </span>
                    {regenerate.isPending ? t('common.saving') : t('summary.regenerate')}
                  </button>
                  <ErrorNote error={regenerate.error} />
                </div>
              )}
            </div>
          )}
        </Modal>
      </div>
    );
  }
  if (stage === 'GENERATING' || stage === 'PROCESSING') return <Status busy title={t('record.summary.GENERATING')} />;
  if (stage === 'WAITING_FOR_TRANSCRIPT') return <Status title={t('record.summary.WAITING_FOR_TRANSCRIPT')} />;
  if (stage === 'UNAVAILABLE') return <Status title={t('record.summary.UNAVAILABLE')} />;
  if (stage === 'FAILED')
    return (
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
        {teacher && d.summary.canGenerate && (
          <button className="btn-secondary" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {t('summary.retry')}
          </button>
        )}
        <ErrorNote error={generate.error} />
      </div>
    );
  if (teacher)
    return (
      <div className="space-y-2">
        <p className="text-sm text-outline">{t('summary.notYetHint')}</p>
        <button
          className="btn-primary"
          disabled={generate.isPending || !d.summary.canGenerate}
          onClick={() => generate.mutate()}
        >
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            auto_awesome
          </span>
          {generate.isPending ? t('common.saving') : t('summary.generate')}
        </button>
        <ErrorNote error={generate.error} />
      </div>
    );
  return <p className="text-sm text-outline">{t('summary.notShared')}</p>;
}

function TranscriptPane({
  sessionId,
  teacher,
  transcript,
}: {
  sessionId: string;
  teacher: boolean;
  transcript: TranscriptView;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [full, setFull] = useState(false);
  const retry = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/transcript/retry`)).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  // The whole text: only when opened.
  const whole = useQuery({
    queryKey: ['live-transcript', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/transcript`)).data as TranscriptView | null,
    enabled: full,
    staleTime: 60_000,
  });
  const s = transcript.stage;
  const retryButton =
    teacher && transcript.canRetry ? (
      <div className="mt-2 space-y-1">
        <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            refresh
          </span>
          {t('record.transcript.retry')}
        </button>
        <ErrorNote error={retry.error} />
      </div>
    ) : null;

  if ((s === 'READY' || s === 'PARTIAL') && transcript.segments?.length) {
    const partial = s === 'PARTIAL' || !!transcript.partial;
    return (
      <div className="space-y-3">
        {partial && <Status title={t('record.transcript.PARTIAL')} hint={t('record.transcript.partial')} />}
        <p dir="auto" className="line-clamp-5 whitespace-pre-wrap text-sm leading-7 text-on-surface-variant">
          {transcript.segments.map((x) => x.text).join(' ')}
        </p>
        <OpenFull onClick={() => setFull(true)}>{t('record.transcript.showAll')}</OpenFull>
        {retryButton}
        <Modal variant="sheet" open={full} onClose={() => setFull(false)} title={t('record.transcript.title')}>
          {full &&
            (whole.isLoading ? (
              <div className="space-y-3" aria-busy>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : whole.isError ? (
              <ErrorNote error={whole.error} />
            ) : whole.data?.segments?.length ? (
              <TranscriptViewer segments={whole.data.segments} partial={partial} expanded />
            ) : (
              <Status title={t('record.transcript.UNAVAILABLE')} />
            ))}
        </Modal>
      </div>
    );
  }
  if (s === 'READY') return <Status tone="good" title={t('record.transcript.READY')} />;
  if (s === 'PARTIAL') return <Status title={t('record.transcript.PARTIAL')} hint={t('record.transcript.partial')} />;
  if (s === 'UNAVAILABLE' && transcript.reason === 'TRANSCRIPTION_OFF') return <Status title={t('record.transcript.OFF')} />;
  if (s === 'UNAVAILABLE')
    return (
      <Status
        title={t('record.transcript.UNAVAILABLE')}
        hint={transcript.reason ? t(`record.transcript.reason.${transcript.reason}`) : undefined}
      />
    );
  if (s === 'FAILED')
    return (
      <>
        <Status
          tone="bad"
          title={t('record.transcript.FAILED')}
          hint={
            transcript.reason === 'SERVICE_UNAVAILABLE'
              ? t('record.transcript.reason.SERVICE_UNAVAILABLE')
              : t('record.transcript.failedHint')
          }
        />
        {retryButton}
      </>
    );
  if (s === 'AT_PROVIDER') return <Status title={t('record.transcript.AT_PROVIDER')} />;
  if (s === 'WAITING_FOR_CLASS_END') return <Status title={t('record.transcript.WAITING_FOR_CLASS_END')} />;
  return (
    <Status
      busy
      title={t(`record.transcript.${s}`)}
      hint={
        s === 'TRANSCRIBING' && transcript.progress && transcript.progress.total > 1
          ? t('record.transcript.progress', transcript.progress)
          : undefined
      }
    />
  );
}

function ContentCard({ sessionId, d, teacher }: { sessionId: string; d: any; teacher: boolean }) {
  const { t } = useTranslation();
  const hasTranscript = !!d.transcript;
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary');
  const current = hasTranscript ? tab : 'summary';
  const sStage: string = d.summary.stage ?? d.summary.status;
  const tStage: string | undefined = d.transcript?.stage;
  const aside =
    teacher && current === 'summary' && sStage === 'READY' && d.summary.visibility ? (
      <VisibilityPicker sessionId={sessionId} resource="summary" value={d.summary.visibility} />
    ) : teacher && current === 'transcript' && d.transcript?.visibility && (tStage === 'READY' || tStage === 'PARTIAL') ? (
      <VisibilityPicker sessionId={sessionId} resource="transcript" value={d.transcript.visibility} />
    ) : null;
  return (
    <Card id="rec-content" icon="menu_book" title={t('archive.content')} aside={aside}>
      {hasTranscript && (
        <div role="tablist" aria-label={t('archive.content')} className="mb-3 inline-flex rounded-full bg-surface-container p-1">
          {(['summary', 'transcript'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={current === k}
              onClick={() => setTab(k)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                current === k ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {k === 'summary' ? t('record.nav.summary') : t('record.nav.transcript')}
            </button>
          ))}
        </div>
      )}
      <div role="tabpanel">
        {current === 'summary' ? (
          <SummaryPane sessionId={sessionId} d={d} teacher={teacher} />
        ) : (
          <TranscriptPane sessionId={sessionId} teacher={teacher} transcript={d.transcript} />
        )}
      </div>
    </Card>
  );
}

// ── Attendance ─────────────────────────────────────────────────────────────

function StatusChip({ row }: { row: AttendanceRow }) {
  const { t } = useTranslation();
  if (!row.status) return null;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
        row.status === 'ATTENDED'
          ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
      }`}
    >
      {t(`archive.att.${row.status}`)}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-container-highest text-sm font-bold"
    >
      {initialOf(name)}
    </span>
  );
}

function AttendanceLine({ row, detail }: { row: AttendanceRow; detail?: boolean }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const facts = [
    row.spokeCount ? t('archive.att.spoke', { count: row.spokeCount }) : null,
    row.raisedCount ? t('archive.att.raised', { count: row.raisedCount }) : null,
    row.bonusPoints ? t('archive.att.bonus', { points: row.bonusPoints }) : null,
  ].filter(Boolean);
  return (
    <li className="py-2">
      <div className="flex items-center gap-3">
        <Avatar name={row.fullName} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold" dir="auto">
            <span className="truncate">{row.fullName}</span>
            {row.guest && <span className="shrink-0 text-xs font-normal text-outline">({t('liveManage.guest')})</span>}
          </p>
          <p className="text-xs text-outline">
            {minutesOf(row.durationSeconds, t)}
            {row.percent != null && <span className="tabular-nums"> · {row.percent}%</span>}
            {facts.length > 0 && <> · {facts.join(' · ')}</>}
          </p>
        </div>
        <StatusChip row={row} />
        {detail && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={t('archive.att.details', { name: row.fullName })}
            onClick={() => setOpen((v) => !v)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-outline hover:bg-surface-container-low"
          >
            <span aria-hidden className={`material-symbols-outlined text-[20px] transition ${open ? 'rotate-180' : ''}`}>
              expand_more
            </span>
          </button>
        )}
      </div>
      {detail && open && (
        <dl className="ms-11 mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-surface-container-low p-3 text-xs">
          <dt className="text-outline">{t('archive.att.firstJoin')}</dt>
          <dd dir="ltr" className="text-end tabular-nums">{timeOf(row.joinedAt, i18n.language)}</dd>
          <dt className="text-outline">{t('archive.att.lastSeen')}</dt>
          <dd dir="ltr" className="text-end tabular-nums">{timeOf(row.leftAt ?? row.lastSeenAt, i18n.language)}</dd>
          <dt className="text-outline">{t('archive.att.dropouts')}</dt>
          <dd className="text-end tabular-nums">{row.reconnects}</dd>
          <dt className="text-outline">{t('archive.att.micOpen')}</dt>
          <dd className="text-end">{row.micOpenSeconds ? minutesOf(row.micOpenSeconds, t) : '—'}</dd>
        </dl>
      )}
    </li>
  );
}

function AttendanceCard({ report }: { report: AttendanceReport }) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const students = studentsByAttention(report.rows);
  const teachers = report.rows.filter((r) => r.role === 'TEACHER');
  const sum = report.summary;
  const stats: [string, string][] = [
    [t('archive.att.joined'), sum.expected ? t('archive.att.ofExpected', { joined: sum.joined, expected: sum.expected }) : String(sum.joined)],
    [t('archive.att.absent'), String(sum.absent)],
    [t('archive.att.average'), sum.averagePercent != null ? `${sum.averagePercent}%` : '—'],
  ];
  return (
    <Card id="rec-attendance" icon="how_to_reg" title={t('live.attendance')}>
      <dl className="grid grid-cols-3 gap-2">
        {stats.map(([k, v]) => (
          <div key={k} className="rounded-xl bg-surface-container-low px-3 py-2">
            <dt className="text-[11px] font-semibold text-outline">{k}</dt>
            <dd className="font-heading text-lg font-bold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {!students.length ? (
        <p className="mt-3 text-sm text-outline">{t('live.noAttendance')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-outline-variant/40">
          {students.slice(0, 4).map((r) => (
            <AttendanceLine key={r.id} row={r} />
          ))}
        </ul>
      )}
      {(students.length > 4 || report.absent.length > 0 || students.length > 0) && (
        <OpenFull onClick={() => setFull(true)}>{t('archive.att.showAll')}</OpenFull>
      )}
      <Modal variant="sheet" open={full} onClose={() => setFull(false)} title={t('live.attendance')}>
        {full && (
          <div className="space-y-5">
            <p className="text-sm text-on-surface-variant">
              {sum.runSeconds ? t('archive.att.ran', { duration: minutesOf(sum.runSeconds, t) }) : null}
              {sum.attendedThresholdSeconds
                ? ` · ${t('archive.att.thresholdHint', { duration: minutesOf(sum.attendedThresholdSeconds, t) })}`
                : null}
            </p>
            <section>
              <h3 className="mb-1 text-xs font-bold text-on-surface-variant">
                {t('archive.att.students', { count: students.length })}
              </h3>
              <ul className="divide-y divide-outline-variant/40">
                {students.map((r) => (
                  <AttendanceLine key={r.id} row={r} detail />
                ))}
              </ul>
            </section>
            {report.absent.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-bold text-on-surface-variant">
                  {t('archive.att.absentList', { count: report.absent.length })}
                </h3>
                <ul className="divide-y divide-outline-variant/40">
                  {report.absent.map((a) => (
                    <li key={a.userId} className="flex items-center gap-3 py-2 text-sm">
                      <Avatar name={a.fullName} />
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {a.fullName}
                        {a.guest && <span className="ms-1 text-xs text-outline">({t('liveManage.guest')})</span>}
                      </span>
                      <span className="text-xs text-outline">{t('archive.att.didNotJoin')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {teachers.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-bold text-on-surface-variant">{t('archive.att.staff')}</h3>
                <ul className="divide-y divide-outline-variant/40">
                  {teachers.map((r) => (
                    <AttendanceLine key={r.id} row={r} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}

// ── Chat ───────────────────────────────────────────────────────────────────

function ChatGroups({ messages }: { messages: ArchiveMessage[] }) {
  const { t, i18n } = useTranslation();
  const groups = useMemo(() => groupMessages(messages), [messages]);
  return (
    <ol className="space-y-3">
      {groups.map((g) => (
        <li key={g.key}>
          {g.pauseBefore && (
            <div className="my-3 flex items-center gap-2 text-[11px] text-outline" aria-hidden>
              <span className="h-px flex-1 bg-outline-variant/60" />
              <span dir="ltr" className="tabular-nums">{timeOf(g.at, i18n.language)}</span>
              <span className="h-px flex-1 bg-outline-variant/60" />
            </div>
          )}
          <div className="flex gap-2.5">
            <Avatar name={g.senderName} />
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className="font-semibold text-on-surface" dir="auto">
                  {g.senderName}
                </span>
                {g.senderRole === 'TEACHER' && (
                  <span className="ms-1.5 rounded-full bg-primary-fixed px-1.5 py-0.5 text-[10px] font-bold text-on-primary-fixed">
                    {t('meeting.teacherBadge')}
                  </span>
                )}
                {g.senderRole === 'GUEST' && <span className="ms-1.5 text-outline">({t('liveManage.guest')})</span>}
                <span dir="ltr" className="ms-2 tabular-nums text-outline">{timeOf(g.at, i18n.language)}</span>
              </p>
              <div className="mt-0.5 space-y-1">
                {g.messages.map((m) => (
                  <p
                    key={m.id}
                    dir="auto"
                    title={timeOf(m.createdAt, i18n.language)}
                    className="whitespace-pre-wrap break-words text-sm leading-6"
                  >
                    {m.body}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ChatCard({ sessionId, count }: { sessionId: string; count: number }) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const preview = useQuery({
    queryKey: ['live-chat-preview', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/chat`, { params: { limit: 4 } })).data as ArchiveMessage[],
    enabled: count > 0,
  });
  // The whole conversation, newest page first; older pages as the reader asks.
  const pages = useInfiniteQuery({
    queryKey: ['live-chat-archive', sessionId],
    queryFn: async ({ pageParam }) =>
      (
        await api.get(`/live/${sessionId}/chat`, {
          params: { limit: CHAT_PAGE, ...(pageParam ? { before: pageParam } : {}) },
        })
      ).data as ArchiveMessage[],
    initialPageParam: '' as string,
    getNextPageParam: (last) => (last.length === CHAT_PAGE ? last[0].id : undefined),
    enabled: full,
  });
  const all = useMemo(() => (pages.data ? [...pages.data.pages].reverse().flat() : []), [pages.data]);
  return (
    <Card
      id="rec-chat"
      icon="forum"
      title={t('record.chat.title')}
      aside={count ? <span className="text-xs text-outline">{t('record.chat.count', { count })}</span> : null}
    >
      {!count ? (
        <p className="text-sm text-outline">{t('record.chat.empty')}</p>
      ) : preview.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <ChatGroups messages={preview.data ?? []} />
          <OpenFull onClick={() => setFull(true)}>{t('archive.chatFull')}</OpenFull>
        </>
      )}
      <Modal
        variant="sheet"
        open={full}
        onClose={() => setFull(false)}
        title={t('record.chat.title')}
        actions={<span className="text-xs text-outline">{t('record.chat.count', { count })}</span>}
      >
        {full &&
          (pages.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : pages.isError ? (
            <ErrorNote error={pages.error} />
          ) : (
            <div className="space-y-3">
              {pages.hasNextPage && (
                <button
                  type="button"
                  className="btn-secondary w-full justify-center !py-2 text-sm"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage ? t('common.loading') : t('archive.olderMessages')}
                </button>
              )}
              <ChatGroups messages={all} />
            </div>
          ))}
      </Modal>
    </Card>
  );
}

// ── The page ───────────────────────────────────────────────────────────────

export default function LiveArchive({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
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
  const teacher = detail.data?.role === 'TEACHER';
  const attendance = useQuery({
    queryKey: ['live-attendance', sessionId],
    queryFn: async () => (await api.get(`/teacher/live/${sessionId}/attendance`)).data as AttendanceReport,
    enabled: teacher,
  });

  if (detail.isLoading)
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (detail.isError) return <ErrorNote error={detail.error} />;
  const d = detail.data;
  const sum = attendance.data?.summary;

  return (
    <div className="space-y-4">
      {/* The facts, in one line. */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-on-surface-variant">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            event
          </span>
          {new Date(d.startsAt).toLocaleString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            timer
          </span>
          {d.actualDurationSec != null
            ? t('record.actualDuration', { duration: minutesOf(d.actualDurationSec, t) })
            : t('live.minutes', { count: d.durationMin })}
        </span>
        {sum && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="material-symbols-outlined text-[18px]">
              group
            </span>
            {sum.expected
              ? t('archive.att.ofExpected', { joined: sum.joined, expected: sum.expected })
              : t('record.attendedCount', { count: sum.joined })}
            {sum.averagePercent != null && ` · ${t('archive.att.averageShort', { pct: sum.averagePercent })}`}
          </span>
        )}
      </div>

      <RecordingCard sessionId={sessionId} teacher={teacher} recording={d.recording} />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ContentCard sessionId={sessionId} d={d} teacher={teacher} />
        </div>
        <div className="space-y-4 lg:col-span-2">
          {teacher && (attendance.data ? <AttendanceCard report={attendance.data} /> : attendance.isError ? <ErrorNote error={attendance.error} /> : <Skeleton className="h-40 w-full" />)}
          <ChatCard sessionId={sessionId} count={d.chat?.count ?? 0} />
        </div>
      </div>

      {/* The class, reused as course content — teacher side, once it has ended
          and its recording plays. */}
      {teacher && d.status === 'ENDED' && d.recording?.playable && (
        <LiveContentSection sessionId={sessionId} sessionTitle={d.title} />
      )}
    </div>
  );
}

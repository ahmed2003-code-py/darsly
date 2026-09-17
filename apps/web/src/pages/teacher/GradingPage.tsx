import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, Modal, PageHeader, Skeleton, Spinner } from '../../components/ui';

/**
 * Everything waiting to be marked, and the room to mark it in.
 *
 * Marking used to happen in a narrow column beside the quiz builder, one lesson
 * at a time: a teacher had to remember which lessons had quizzes, open each
 * one, and read a list squeezed into a sidebar — and the box they typed the
 * mark into was an unlabelled text field that quietly turned anything that was
 * not a digit into a zero.
 *
 * So this screen starts from the work rather than the lesson it lives in, and
 * gives one answer a teacher can act on: who is waiting, in which course, for
 * how long. The marking itself opens full width, with the question, what the
 * teacher said a good answer looks like, and what the student actually wrote,
 * side by side — which is the whole job.
 */

interface QueueItem {
  id: string;
  kind: 'QUIZ' | 'ASSIGNMENT';
  studentName: string;
  lessonId: string;
  lessonTitle: string;
  unitTitle: string;
  submittedAt: string | null;
}
interface QueueCourse {
  courseId: string;
  courseTitle: string;
  pending: number;
  items: QueueItem[];
}

type View = 'queue' | 'analysis';

export default function GradingPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('queue');
  return (
    <div className="page">
      <PageHeader title={t('grading.title')} subtitle={t('grading.pageSubtitle')} />
      <div className="mb-5 flex gap-2">
        {(['queue', 'analysis'] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors ${
              view === v ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {t(`grading.view.${v}`)}
          </button>
        ))}
      </div>
      {view === 'queue' ? <Queue /> : <Analysis />}
    </div>
  );
}

function Queue() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState<QueueItem | null>(null);
  const [openCourse, setOpenCourse] = useState<string | null>(null);

  const { data: queue, isLoading } = useQuery<QueueCourse[]>({
    queryKey: ['grading-queue'],
    queryFn: async () => (await api.get('/teacher/grading')).data,
  });

  const total = (queue ?? []).reduce((n, c) => n + c.pending, 0);
  // With one course waiting there is nothing to choose between, so it opens
  // itself rather than asking for a click that has only one possible answer.
  const expanded = openCourse ?? (queue?.length === 1 ? queue[0].courseId : null);

  return (
    <>
      {total > 0 && (
        <p className="mb-3 text-sm text-on-surface-variant">{t('grading.subtitleN', { count: total })}</p>
      )}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      ) : !queue?.length ? (
        <EmptyState icon="task_alt" title={t('grading.allDone')} hint={t('grading.allDoneHint')} />
      ) : (
        <div className="space-y-4">
          {queue.map((c) => {
            const isOpen = expanded === c.courseId;
            return (
              <section key={c.courseId} className="card overflow-hidden !p-0">
                <button
                  onClick={() => setOpenCourse(isOpen ? '' : c.courseId)}
                  className="flex w-full items-center gap-3 p-card text-start transition-colors hover:bg-surface-container-low"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-container text-on-primary-container">
                    <span className="material-symbols-outlined">menu_book</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-heading font-bold">{c.courseTitle}</span>
                    <span className="block text-xs text-on-surface-variant">
                      {t('grading.waitingN', { count: c.pending })}
                    </span>
                  </span>
                  <Badge tone="warn">{c.pending}</Badge>
                  <span className={`material-symbols-outlined text-outline transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </button>

                {isOpen && (
                  <ul className="border-t border-outline-variant/40">
                    {c.items.map((it) => (
                      <li key={`${it.kind}-${it.id}`}>
                        <button
                          onClick={() => setOpen(it)}
                          className="flex w-full items-center gap-3 border-b border-outline-variant/30 px-card py-3 text-start transition-colors last:border-b-0 hover:bg-surface-container-low"
                        >
                          <span className="material-symbols-outlined text-[20px] text-outline">
                            {it.kind === 'QUIZ' ? 'quiz' : 'assignment'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-bold">{it.studentName}</span>
                            <span className="block truncate text-xs text-on-surface-variant">
                              {t(`grading.kind.${it.kind}`)} · {it.lessonTitle}
                            </span>
                          </span>
                          {it.submittedAt && (
                            <span className="hidden shrink-0 text-xs text-outline sm:block">
                              {dateShort(it.submittedAt)}
                            </span>
                          )}
                          <span className="btn-ghost shrink-0 px-3 py-1.5 text-xs">{t('grading.mark')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} title={t('grading.markTitle')} wide>
        {open && (
          <MarkPanel
            item={open}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ['grading-queue'] });
              setOpen(null);
            }}
          />
        )}
      </Modal>
    </>
  );
}

/** A whole number between 0 and `max`, or nothing — never a silent zero. */
function scoreFrom(raw: string, max: number): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  return Math.min(Number(digits), max);
}

function MarkPanel({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const { t } = useTranslation();
  const isQuiz = item.kind === 'QUIZ';
  const { data, isLoading } = useQuery<any>({
    queryKey: ['grading-item', item.kind, item.id],
    queryFn: async () =>
      (await api.get(isQuiz ? `/teacher/grading/quiz-attempts/${item.id}` : `/teacher/grading/submissions/${item.id}`)).data,
  });

  const [scores, setScores] = useState<Record<string, string>>({});
  const [score, setScore] = useState('');
  const [feedback, setFeedback] = useState('');

  const submit = useMutation({
    mutationFn: async () => {
      if (isQuiz) {
        const out: Record<string, number> = {};
        for (const q of data.questions) out[q.id] = scoreFrom(scores[q.id] ?? '', q.points) ?? 0;
        return (await api.post(`/teacher/quiz-attempts/${item.id}/grade`, { scores: out })).data;
      }
      return (
        await api.post(`/teacher/assignment-submissions/${item.id}/grade`, {
          score: scoreFrom(score, data.maxScore ?? 100) ?? 0,
          feedback: feedback.trim() || undefined,
        })
      ).data;
    },
    onSuccess: onDone,
  });

  if (isLoading || !data) return <div className="grid place-items-center py-12"><Spinner /></div>;

  // Every question must have a mark before the paper can be finalised. Leaving
  // one blank used to record a zero, which is a mark nobody chose to give.
  const unmarked = isQuiz
    ? data.questions.filter((q: any) => scoreFrom(scores[q.id] ?? '', q.points) === null).length
    : scoreFrom(score, data.maxScore ?? 100) === null
      ? 1
      : 0;
  const awarded = isQuiz
    ? data.questions.reduce((n: number, q: any) => n + (scoreFrom(scores[q.id] ?? '', q.points) ?? 0), 0)
    : scoreFrom(score, data.maxScore ?? 100) ?? 0;
  const outOf = isQuiz
    ? data.questions.reduce((n: number, q: any) => n + q.points, 0)
    : data.maxScore ?? 100;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-outline-variant/40 pb-3">
        <span className="font-heading text-lg font-bold">{data.studentName}</span>
        <Badge tone="neutral">{t(`grading.kind.${item.kind}`)}</Badge>
        <span className="text-xs text-on-surface-variant">
          {data.courseTitle} · {data.lessonTitle}
        </span>
      </div>

      {isQuiz ? (
        data.questions.length === 0 ? (
          <p className="text-sm text-on-surface-variant">{t('grading.nothingToMark')}</p>
        ) : (
          <ol className="space-y-5">
            {data.questions.map((q: any, i: number) => (
              <li key={q.id} className="rounded-2xl border border-outline-variant/60 p-4">
                <p className="mb-3 font-bold" dir="auto">
                  <span className="text-outline">{i + 1}.</span> {q.prompt}
                </p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.studentAnswer')}</p>
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface-container-low p-3 text-sm" dir="auto">
                      {q.answer || <span className="text-outline">{t('grading.blank')}</span>}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.modelAnswer')}</p>
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-secondary/40 bg-secondary-container/25 p-3 text-sm" dir="auto">
                      {q.modelAnswer || <span className="text-outline">{t('grading.noModel')}</span>}
                    </div>
                  </div>
                </div>

                {/* What the automatic marker thought, when it ran. Shown as an
                    opinion to weigh, never as a mark already given. */}
                {q.ai && (
                  <p className="mt-2 flex items-start gap-2 rounded-xl bg-surface-container-low px-3 py-2 text-xs leading-5 text-on-surface-variant">
                    <span className="material-symbols-outlined text-[16px] leading-5 text-primary">auto_awesome</span>
                    <span>
                      {t('grading.aiSaid', { pct: q.ai.similarityPct ?? 0 })}
                      {q.ai.reason ? ` — ${q.ai.reason}` : ''}
                    </span>
                  </p>
                )}

                <ScoreField
                  value={scores[q.id] ?? ''}
                  max={q.points}
                  onChange={(v) => setScores((s) => ({ ...s, [q.id]: v }))}
                />
              </li>
            ))}
          </ol>
        )
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.prompt')}</p>
            <div className="whitespace-pre-wrap rounded-xl bg-surface-container-low p-3 text-sm" dir="auto">{data.prompt}</div>
          </div>
          <div>
            <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.studentAnswer')}</p>
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-outline-variant/60 p-3 text-sm" dir="auto">
              {data.body || <span className="text-outline">{t('grading.blank')}</span>}
            </div>
            {data.hasFile && <p className="mt-1 text-xs text-outline">{t('grading.hasFile')}</p>}
          </div>
          <ScoreField value={score} max={data.maxScore ?? 100} onChange={setScore} />
          <div>
            <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.feedback')}</p>
            <textarea
              className="input min-h-20"
              dir="auto"
              maxLength={1000}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t('grading.feedbackPh')}
            />
          </div>
        </div>
      )}

      <ErrorNote error={submit.error} />

      <div className="sticky bottom-0 mt-5 flex flex-wrap items-center gap-3 border-t border-outline-variant/40 bg-surface pt-3">
        <span className="font-heading text-lg font-bold tabular-nums" dir="ltr">
          {awarded} / {outOf}
        </span>
        {unmarked > 0 && (
          <span className="text-xs text-on-surface-variant">{t('grading.unmarkedN', { count: unmarked })}</span>
        )}
        <button
          className="btn-primary ms-auto"
          disabled={submit.isPending || unmarked > 0}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? t('common.saving') : t('grading.finalize')}
        </button>
      </div>
    </div>
  );
}

/**
 * The mark, out of what it can be.
 *
 * The field this replaces was a bare text box that accepted anything, said
 * nothing about the maximum, and turned whatever it could not read into a zero
 * without saying so. This one takes digits only, cannot be pushed past the
 * question's own points, and says what it is out of next to the box rather than
 * in a placeholder that vanishes the moment anyone types.
 */
function ScoreField({ value, max, onChange }: { value: string; max: number; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const clamped = scoreFrom(value, max);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="text-xs font-bold text-on-surface-variant">{t('grading.award')}</label>
      <input
        className="input w-24 py-1.5 text-center tabular-nums"
        dir="ltr"
        inputMode="numeric"
        value={clamped === null ? '' : String(clamped)}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        aria-label={t('grading.award')}
      />
      <span className="text-sm text-on-surface-variant">{t('grading.outOf', { max })}</span>
      <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => onChange(String(max))}>
        {t('grading.full')}
      </button>
      <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => onChange('0')}>
        {t('grading.zero')}
      </button>
    </div>
  );
}

/**
 * Results, read the way a teacher looks for them: course, then paper, then
 * student, then that student's paper.
 *
 * The first version put every paper from every course in one flat list and
 * opened a modal on top of it. That answers "how did the class do" and nothing
 * else — there was no way to reach one student, and exams and written work sat
 * mixed together as though they were the same thing. This drills instead, with
 * a trail back, and a search box at each level that has enough rows to need one.
 */
interface PaperRow {
  lessonId: string;
  lessonTitle: string;
  unitTitle: string;
  attempts?: number;
  submissions?: number;
  avgPct?: number | null;
  avgScore?: number | null;
  maxScore?: number;
  openReports?: number;
  pendingGrading: number;
}
interface AnalysisCourse {
  courseId: string;
  courseTitle: string;
  quizzes: PaperRow[];
  assignments: PaperRow[];
}
type Paper = { kind: 'QUIZ' | 'ASSIGNMENT'; lessonId: string; lessonTitle: string };

/** One search box, used at every level. Hidden when there is nothing to sift. */
function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mb-4">
      <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-[20px] text-outline">
        search
      </span>
      <input
        className="input ps-11"
        dir="auto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

/** The trail back. Always shows where you are, and every step is a way out. */
function Crumbs({ steps }: { steps: { label: string; onClick?: () => void }[] }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm">
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="material-symbols-outlined text-[18px] text-outline">chevron_left</span>}
          {s.onClick ? (
            <button onClick={s.onClick} className="rounded px-1 font-bold text-primary hover:underline">
              {s.label}
            </button>
          ) : (
            <span className="px-1 text-on-surface-variant">{s.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function Analysis() {
  const { t } = useTranslation();
  const [course, setCourse] = useState<AnalysisCourse | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery<AnalysisCourse[]>({
    queryKey: ['grading-analysis'],
    queryFn: async () => (await api.get('/teacher/grading/analysis')).data,
  });

  // The trail is rebuilt from the state rather than remembered, so there is no
  // way for it to describe somewhere you are not.
  const crumbs = [
    { label: t('grading.allCourses'), onClick: course ? () => { setCourse(null); setPaper(null); setAttemptId(null); setQ(''); } : undefined },
    ...(course ? [{ label: course.courseTitle, onClick: paper ? () => { setPaper(null); setAttemptId(null); setQ(''); } : undefined }] : []),
    ...(paper ? [{ label: paper.lessonTitle, onClick: attemptId ? () => { setAttemptId(null); setQ(''); } : undefined }] : []),
  ];

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
      </div>
    );
  }
  if (!data?.length) {
    return <EmptyState icon="query_stats" title={t('grading.noResults')} hint={t('grading.noResultsHint')} />;
  }

  if (attemptId) {
    return (
      <>
        <Crumbs steps={crumbs} />
        <AttemptReview attemptId={attemptId} />
      </>
    );
  }

  if (paper) {
    return (
      <>
        <Crumbs steps={crumbs} />
        <PaperView paper={paper} search={q} onSearch={setQ} onOpenAttempt={setAttemptId} />
      </>
    );
  }

  if (course) {
    return (
      <>
        <Crumbs steps={crumbs} />
        <CourseView course={course} search={q} onSearch={setQ} onOpen={setPaper} />
      </>
    );
  }

  const courses = data.filter((c) => c.courseTitle.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      {data.length > 4 && <Search value={q} onChange={setQ} placeholder={t('grading.searchCourses')} />}
      {!courses.length ? (
        <EmptyState icon="search_off" title={t('grading.noMatch')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {courses.map((c) => {
            const waiting =
              c.quizzes.reduce((n, p) => n + p.pendingGrading, 0) +
              c.assignments.reduce((n, p) => n + p.pendingGrading, 0);
            const reports = c.quizzes.reduce((n, p) => n + (p.openReports ?? 0), 0);
            return (
              <button
                key={c.courseId}
                onClick={() => { setCourse(c); setQ(''); }}
                className="card flex items-center gap-3 text-start transition-colors hover:bg-surface-container-low"
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary-container text-on-primary-container">
                  <span className="material-symbols-outlined">menu_book</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-heading font-bold">{c.courseTitle}</span>
                  <span className="mt-0.5 block text-xs text-on-surface-variant">
                    {t('grading.papersN', { count: c.quizzes.length })} · {t('grading.workN', { count: c.assignments.length })}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {waiting > 0 && <Badge tone="warn">{t('grading.waitingN', { count: waiting })}</Badge>}
                  {reports > 0 && <Badge tone="error">{t('grading.reportsN', { count: reports })}</Badge>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** A course's papers, with exams and written work kept apart. */
function CourseView({
  course, search, onSearch, onOpen,
}: { course: AnalysisCourse; search: string; onSearch: (v: string) => void; onOpen: (p: Paper) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'QUIZ' | 'ASSIGNMENT'>(course.quizzes.length ? 'QUIZ' : 'ASSIGNMENT');
  const rows = (kind === 'QUIZ' ? course.quizzes : course.assignments).filter((p) =>
    `${p.lessonTitle} ${p.unitTitle}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <div className="mb-4 flex gap-2">
        {(['QUIZ', 'ASSIGNMENT'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors ${
              kind === k ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
            }`}
          >
            {t(`grading.kindPlural.${k}`)}
            <span className="ms-2 tabular-nums opacity-70">
              {k === 'QUIZ' ? course.quizzes.length : course.assignments.length}
            </span>
          </button>
        ))}
      </div>

      {(kind === 'QUIZ' ? course.quizzes : course.assignments).length > 5 && (
        <Search value={search} onChange={onSearch} placeholder={t('grading.searchPapers')} />
      )}

      {!rows.length ? (
        <EmptyState icon="inbox" title={t('grading.noPapers')} />
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.lessonId}>
              <button
                onClick={() => onOpen({ kind, lessonId: p.lessonId, lessonTitle: p.lessonTitle })}
                className="card flex w-full items-center gap-3 text-start transition-colors hover:bg-surface-container-low"
              >
                <span className="material-symbols-outlined text-outline">
                  {kind === 'QUIZ' ? 'quiz' : 'assignment'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{p.lessonTitle}</span>
                  <span className="block truncate text-xs text-on-surface-variant">
                    {p.unitTitle} · {t('grading.attemptsN', { count: p.attempts ?? p.submissions ?? 0 })}
                    {p.avgPct != null ? ` · ${t('grading.avg', { pct: p.avgPct })}` : ''}
                    {p.avgScore != null ? ` · ${t('grading.avgScore', { score: p.avgScore, max: p.maxScore ?? 100 })}` : ''}
                  </span>
                </span>
                {p.pendingGrading > 0 && <Badge tone="warn">{t('grading.waitingN', { count: p.pendingGrading })}</Badge>}
                {(p.openReports ?? 0) > 0 && <Badge tone="error">{t('grading.reportsN', { count: p.openReports })}</Badge>}
                <span className="material-symbols-outlined text-outline">chevron_left</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One paper: who sat it, and — for an exam — how each question landed. */
function PaperView({
  paper, search, onSearch, onOpenAttempt,
}: { paper: Paper; search: string; onSearch: (v: string) => void; onOpenAttempt: (id: string) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'students' | 'questions'>('students');
  const isQuiz = paper.kind === 'QUIZ';
  const { data, isLoading } = useQuery<any>({
    queryKey: ['grading-students', paper.kind, paper.lessonId],
    queryFn: async () =>
      (await api.get(
        isQuiz
          ? `/teacher/grading/quizzes/${paper.lessonId}/students`
          : `/teacher/grading/assignments/${paper.lessonId}/students`,
      )).data,
  });

  if (isLoading || !data) return <div className="grid place-items-center py-12"><Spinner /></div>;

  const students = (data.students ?? []).filter((s: any) =>
    s.studentName.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      {isQuiz && (
        <div className="mb-4 flex gap-2">
          {(['students', 'questions'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors ${
                tab === k ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              {t(`grading.paperTab.${k}`)}
            </button>
          ))}
        </div>
      )}

      {isQuiz && tab === 'questions' ? (
        <QuizAnalysis lessonId={paper.lessonId} />
      ) : (
        <>
          {(data.students ?? []).length > 6 && (
            <Search value={search} onChange={onSearch} placeholder={t('grading.searchStudents')} />
          )}
          {!students.length ? (
            <EmptyState icon="group_off" title={t('grading.noStudents')} />
          ) : (
            <ul className="space-y-2">
              {students.map((s: any) => {
                const pending = s.needsManualGrading || s.needsGrading;
                const mark = isQuiz
                  ? s.scorePct != null ? `${s.scorePct}%` : '—'
                  : s.score != null ? `${s.score}/${data.maxScore ?? 100}` : '—';
                return (
                  <li key={s.attemptId ?? s.submissionId}>
                    <button
                      disabled={!isQuiz}
                      onClick={() => isQuiz && onOpenAttempt(s.attemptId)}
                      className={`card flex w-full items-center gap-3 text-start transition-colors ${
                        isQuiz ? 'hover:bg-surface-container-low' : 'cursor-default'
                      }`}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-container-high text-sm font-bold">
                        {s.studentName.trim().charAt(0)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold">{s.studentName}</span>
                        {s.submittedAt && (
                          <span className="block text-xs text-outline">{dateShort(s.submittedAt)}</span>
                        )}
                      </span>
                      {pending ? (
                        <Badge tone="warn">{t('grading.pending')}</Badge>
                      ) : (
                        <Badge tone={isQuiz ? (s.passed ? 'neutral' : 'error') : 'neutral'}>{mark}</Badge>
                      )}
                      {isQuiz && <span className="material-symbols-outlined text-outline">chevron_left</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}
/**
 * One student's paper, question by question.
 *
 * The question this answers is "why did they get this mark", so every question
 * is here — not only the ones marked by hand — with what they chose set against
 * what was right.
 *
 * Right and wrong are **green and red literally**, not through the theme's own
 * colours. Everything else on this screen is repainted by whatever palette the
 * academy published, and the first version used the theme's `secondary` for a
 * correct answer — which on a lavender academy made the right answer lavender
 * and the whole point unreadable. Correctness is not a brand decision; a tick
 * is green in every classroom on earth and must stay green in all of them.
 *
 * A written answer carries its mark and the name of whoever gave it. A mark
 * with no author is a mark nobody can argue with, and the two authors are not
 * worth the same: a teacher's is a judgement, the automatic marker's is a
 * measurement against the model answer, and a student deserves to know which
 * one they got.
 */
function AttemptReview({ attemptId }: { attemptId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<any>({
    queryKey: ['grading-review', attemptId],
    queryFn: async () => (await api.get(`/teacher/grading/quiz-attempts/${attemptId}/review`)).data,
  });
  if (isLoading || !data) return <div className="grid place-items-center py-12"><Spinner /></div>;

  const earned = data.questions.reduce(
    (n: number, q: any) => n + (q.correct === true ? q.points : q.awardedPoints ?? 0),
    0,
  );
  const outOf = data.questions.reduce((n: number, q: any) => n + q.points, 0);

  return (
    <div className="space-y-4">
      {/* Who, and how it went, before any of the detail. */}
      <div className="card flex flex-wrap items-center gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface-container-high font-heading text-lg font-bold">
          {data.studentName.trim().charAt(0)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-heading text-lg font-bold">{data.studentName}</span>
          <span className="block truncate text-xs text-on-surface-variant">
            {data.courseTitle} · {data.lessonTitle}
          </span>
        </span>
        {data.needsManualGrading ? (
          <Badge tone="warn">{t('grading.pending')}</Badge>
        ) : (
          <span className="flex items-center gap-4">
            <span className="text-end">
              <span className="block font-heading text-sm font-bold tabular-nums text-on-surface-variant" dir="ltr">
                {earned} / {outOf}
              </span>
              <span className="text-xs text-outline">{t('grading.marksEarned')}</span>
            </span>
            <span
              className={`grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-center ${
                data.passed ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
              }`}
            >
              <span className="font-heading text-xl font-extrabold tabular-nums" dir="ltr">{data.scorePct}%</span>
            </span>
          </span>
        )}
      </div>

      <ol className="space-y-3">
        {data.questions.map((q: any, i: number) => {
          // A written answer is "right" here only in the sense of having earned
          // its marks; nobody called it correct, somebody awarded it something.
          const full = q.correct === true || (q.awardedPoints != null && q.awardedPoints >= q.points);
          const none = q.correct === false || (q.awardedPoints != null && q.awardedPoints === 0);
          return (
            <li
              key={q.id}
              className={`card border-s-4 ${
                full ? 'border-s-emerald-500' : none ? 'border-s-rose-500' : 'border-s-outline-variant'
              }`}
            >
              <div className="mb-3 flex items-start gap-2">
                <p className="min-w-0 flex-1 font-bold" dir="auto">
                  <span className="text-outline">{i + 1}.</span> {q.prompt}
                </p>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${
                    full
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : none
                        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  }`}
                  dir="ltr"
                >
                  {q.correct !== null
                    ? `${q.correct ? q.points : 0} / ${q.points}`
                    : q.awardedPoints != null
                      ? `${q.awardedPoints} / ${q.points}`
                      : `— / ${q.points}`}
                </span>
              </div>

              {q.correct === null ? (
                <>
                  <p className="mb-1 text-xs font-bold text-on-surface-variant">{t('grading.studentAnswer')}</p>
                  <div className="whitespace-pre-wrap rounded-xl bg-surface-container-low p-3 text-sm" dir="auto">
                    {q.writtenAnswer || <span className="text-outline">{t('grading.blank')}</span>}
                  </div>

                  {/* The mark, and whose it is. */}
                  {q.markedBy && (
                    <p className="mt-2 flex items-center gap-2 text-xs text-on-surface-variant">
                      <span className="material-symbols-outlined text-[16px]">
                        {q.markedBy === 'AI' ? 'auto_awesome' : 'person'}
                      </span>
                      {t(q.markedBy === 'AI' ? 'grading.markedByAi' : 'grading.markedByTeacher', {
                        n: q.awardedPoints,
                        max: q.points,
                      })}
                      {q.ai?.similarityPct != null && ` · ${t('grading.aiSaid', { pct: q.ai.similarityPct })}`}
                    </p>
                  )}
                  {q.ai?.reason && (
                    <p className="mt-1 text-xs leading-5 text-outline" dir="auto">{q.ai.reason}</p>
                  )}

                  {q.modelAnswer && (
                    <p className="mt-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs" dir="auto">
                      <b>{t('grading.modelAnswer')}: </b>{q.modelAnswer}
                    </p>
                  )}
                </>
              ) : (
                <ul className="space-y-1.5">
                  {q.options.map((o: any) => {
                    const chose = q.chosenOptionIds.includes(o.id);
                    const right = q.correctOptionIds.includes(o.id);
                    // Four states, and each one says what it is in words as well
                    // as colour — a teacher checking a mark should not have to
                    // work out what a shade of green meant.
                    return (
                      <li
                        key={o.id}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                          right
                            ? 'border-emerald-500/60 bg-emerald-500/10'
                            : chose
                              ? 'border-rose-500/60 bg-rose-500/10'
                              : 'border-outline-variant/50'
                        }`}
                      >
                        <span
                          className={`material-symbols-outlined text-[20px] ${
                            right
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : chose
                                ? 'text-rose-600 dark:text-rose-400'
                                : 'text-outline/40'
                          }`}
                        >
                          {right ? 'check_circle' : chose ? 'cancel' : 'radio_button_unchecked'}
                        </span>
                        <span className="min-w-0 flex-1" dir="auto">{o.text}</span>
                        {chose && (
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                              right
                                ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                                : 'bg-rose-500/20 text-rose-700 dark:text-rose-300'
                            }`}
                          >
                            {t('grading.theirPick')}
                          </span>
                        )}
                        {right && !chose && (
                          <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                            {t('grading.theRightAnswer')}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {q.explanation && (
                <p className="mt-2 rounded-xl bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant" dir="auto">
                  <b>{t('assess.take.explanation')}: </b>{q.explanation}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function QuizAnalysis({ lessonId }: { lessonId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({
    queryKey: ['grading-quiz', lessonId],
    queryFn: async () => (await api.get(`/teacher/grading/quizzes/${lessonId}`)).data,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['grading-quiz', lessonId] });
    qc.invalidateQueries({ queryKey: ['grading-analysis'] });
  };
  const fixKey = useMutation({
    mutationFn: async (questionId: string) =>
      (await api.post(`/teacher/grading/questions/${questionId}/key`, { correctOptionIds: picked })).data,
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const dismiss = useMutation({
    mutationFn: async (reportId: string) =>
      (await api.post(`/teacher/grading/reports/${reportId}/dismiss`)).data,
    onSuccess: refresh,
  });

  if (isLoading || !data) return <div className="grid place-items-center py-12"><Spinner /></div>;
  if (!data.questions.length) return <p className="text-sm text-on-surface-variant">{t('grading.noKeyed')}</p>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-on-surface-variant">
        {data.courseTitle} · {t('grading.attemptsN', { count: data.attempts })}
      </p>

      {data.questions.map((q: any, i: number) => {
        const isEditing = editing === q.id;
        const topCount = Math.max(1, ...Object.values(q.byOption).map((n) => Number(n)));
        return (
          <div key={q.id} className="rounded-2xl border border-outline-variant/60 p-4">
            <div className="mb-3 flex items-start gap-2">
              <p className="min-w-0 flex-1 font-bold" dir="auto">
                <span className="text-outline">{i + 1}.</span> {q.prompt}
              </p>
              {/* A question almost nobody got right is the signal worth seeing
                  from across the room — it is usually the key, not the class. */}
              <Badge tone={q.correctPct >= 50 ? 'neutral' : 'error'}>
                {t('grading.correctPct', { pct: q.correctPct })}
              </Badge>
            </div>

            <ul className="space-y-1.5">
              {q.options.map((o: any) => {
                const n = Number(q.byOption[o.id] ?? 0);
                const isKey = q.correctOptionIds.includes(o.id);
                return (
                  <li key={o.id} className="flex items-center gap-2">
                    {isEditing ? (
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={picked.includes(o.id)}
                        onChange={(e) =>
                          setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))
                        }
                        aria-label={o.text}
                      />
                    ) : (
                      <span className={`material-symbols-outlined text-[18px] ${isKey ? 'text-secondary' : 'text-outline/40'}`}>
                        {isKey ? 'check_circle' : 'radio_button_unchecked'}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm" dir="auto">{o.text}</span>
                    {/* The bar is the point: a crowd on one wrong option is a
                        wrong key far more often than it is a hard question. */}
                    <span className="h-2 w-28 overflow-hidden rounded-full bg-surface-container-high sm:w-40">
                      <span
                        className={`block h-full rounded-full ${isKey ? 'bg-secondary' : 'bg-outline/40'}`}
                        style={{ width: `${Math.round((n / topCount) * 100)}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-end text-xs tabular-nums text-on-surface-variant" dir="ltr">{n}</span>
                  </li>
                );
              })}
            </ul>

            {q.reports.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {q.reports.map((r: any) => (
                  <li
                    key={r.id}
                    className={`flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-5 ${
                      r.status === 'OPEN' ? 'bg-error-container/30' : 'bg-surface-container-low text-on-surface-variant'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px] leading-5">flag</span>
                    <span className="min-w-0 flex-1">
                      <b>{r.studentName}</b>
                      {r.note ? ` — ${r.note}` : ` — ${t('grading.reportNoNote')}`}
                      {r.status !== 'OPEN' && ` · ${t(`grading.reportStatus.${r.status}`)}`}
                    </span>
                    {r.status === 'OPEN' && (
                      <button
                        className="shrink-0 text-xs font-bold text-primary hover:underline"
                        disabled={dismiss.isPending}
                        onClick={() => dismiss.mutate(r.id)}
                      >
                        {t('grading.dismiss')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {isEditing ? (
                <>
                  <button
                    className="btn-primary py-1.5 text-xs"
                    disabled={fixKey.isPending || picked.length === 0}
                    onClick={() => fixKey.mutate(q.id)}
                  >
                    {fixKey.isPending ? t('common.saving') : t('grading.saveKey')}
                  </button>
                  <button className="btn-ghost py-1.5 text-xs" onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </button>
                  <span className="text-xs text-on-surface-variant">{t('grading.keyHint')}</span>
                </>
              ) : (
                <button
                  className="btn-ghost py-1.5 text-xs"
                  onClick={() => { setEditing(q.id); setPicked(q.correctOptionIds); }}
                >
                  <span className="material-symbols-outlined text-[18px]">edit</span>
                  {t('grading.fixKey')}
                </button>
              )}
            </div>

            {fixKey.isSuccess && editing === null && fixKey.variables === q.id && (
              <p className="mt-2 text-xs text-secondary">
                {t('grading.raisedN', { count: fixKey.data?.raised ?? 0 })}
              </p>
            )}
          </div>
        );
      })}
      <ErrorNote error={fixKey.error || dismiss.error} />
    </div>
  );
}

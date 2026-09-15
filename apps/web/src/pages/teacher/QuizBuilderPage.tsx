import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import i18n from '../../i18n';

type Opt = { id: string; text: string };
type Q = {
  type: 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  prompt: string;
  options: Opt[];
  /** Every option that counts as right. One for most questions. */
  correctOptionIds: string[];
  /** How many the student may pick. `1` is an ordinary multiple choice. */
  maxSelections: number;
  /** What a good essay answer says. Read while grading, shown afterwards. */
  modelAnswer: string;
  explanation: string;
  /** Held as text so the box can be emptied while it is being retyped. */
  points: string;
};

const rid = () => Math.random().toString(36).slice(2, 8);
const blankQ = (type: Q['type']): Q => {
  const base = { prompt: '', maxSelections: 1, modelAnswer: '', explanation: '', points: '1' };
  if (type === 'TRUE_FALSE') {
    return {
      ...base, type,
      options: [{ id: 'true', text: i18n.t('assess.true') }, { id: 'false', text: i18n.t('assess.false') }],
      correctOptionIds: ['true'],
    };
  }
  if (type === 'SHORT_ANSWER') {
    return { ...base, type, options: [], correctOptionIds: [] };
  }
  // Four, because four is what a multiple-choice question looks like. Starting
  // at two meant adding two more every single time.
  const ids = [rid(), rid(), rid(), rid()];
  return { ...base, type: 'MCQ', options: ids.map((id) => ({ id, text: '' })), correctOptionIds: [ids[0]] };
};

export default function QuizBuilderPage() {
  const { t } = useTranslation();
  const { lessonId } = useParams();
  const [search] = useSearchParams();
  const fromCourse = search.get('course');
  const backTo = fromCourse ? `/teacher/courses/${fromCourse}?lesson=${lessonId}` : '/teacher/courses';
  const qc = useQueryClient();

  const [passingScore, setPassingScore] = useState(50);
  const [remedialLessonId, setRemedialLessonId] = useState('');
  // Held as text like `points` is, so the box can be emptied to retype it.
  const [timeLimitMin, setTimeLimitMin] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [shuffle, setShuffle] = useState(false);
  const [aiGrading, setAiGrading] = useState(false);
  const [aiThresholdPct, setAiThresholdPct] = useState(60);
  const [showAnswers, setShowAnswers] = useState(true);
  const [questions, setQuestions] = useState<Q[]>([]);
  const [gradingId, setGradingId] = useState<string | null>(null);

  // The course's video lessons, so the remedy is picked rather than typed.
  const { data: courseData } = useQuery({
    queryKey: ['teacher-course', fromCourse],
    queryFn: async () => (await api.get(`/teacher/courses/${fromCourse}`)).data,
    enabled: !!fromCourse,
    staleTime: 60_000,
  });
  const videoLessons: { id: string; title: string }[] = (courseData?.units ?? []).flatMap(
    (u: any) => (u.lessons ?? []).filter((l: any) => l.type === 'VIDEO').map((l: any) => ({ id: l.id, title: l.title })),
  );

  const { data, isLoading } = useQuery({
    queryKey: ['tquiz', lessonId],
    queryFn: async () => (await api.get(`/teacher/lessons/${lessonId}/quiz`)).data,
  });

  useEffect(() => {
    if (data) {
      setPassingScore(data.passingScore ?? 50);
      setRemedialLessonId(data.remedialLessonId ?? '');
      // Minutes in the UI, seconds on the wire — nobody sets an exam in seconds.
      setTimeLimitMin(data.timeLimitSec ? String(Math.round(data.timeLimitSec / 60)) : '');
      setMaxAttempts(data.maxAttempts != null ? String(data.maxAttempts) : '');
      setShuffle(!!data.shuffleQuestions);
      setAiGrading(!!data.aiGrading);
      setAiThresholdPct(data.aiThresholdPct ?? 60);
      setShowAnswers(data.showAnswers ?? true);
      setQuestions(
        (data.questions ?? []).map((q: any) => ({
          type: q.type,
          prompt: q.prompt,
          options: q.options ?? [],
          correctOptionIds: q.correctOptionIds?.length
            ? q.correctOptionIds
            : q.correctOptionId
              ? [q.correctOptionId]
              : [],
          maxSelections: q.maxSelections ?? 1,
          modelAnswer: q.modelAnswer ?? '',
          explanation: q.explanation ?? '',
          points: String(q.points ?? 1),
        })),
      );
    }
  }, [data]);

  /**
   * Written questions with no model answer, while automatic marking is asked
   * for. Caught here so the teacher is told which question to go and fill in
   * before anything is sent; the server refuses it too, as the backstop.
   */
  const unmarkable = aiGrading
    ? questions.filter((q) => q.type === 'SHORT_ANSWER' && !q.modelAnswer.trim())
    : [];

  const save = useMutation({
    mutationFn: async () => {
      // The score is typed, so it can be mid-edit or empty when Save is pressed.
      // One is the floor because a question worth nothing is not a question.
      const payload = questions.map((q) => ({
        ...q,
        points: Math.max(1, Number(q.points) || 1),
        maxSelections: Math.max(1, Math.min(q.maxSelections, q.options.length || 1)),
      }));
      // Questions before settings, and the pending automatic-marking value goes
      // with them: the model-answer rule has to be checked against the questions
      // and the setting as they will be, not half of each.
      const saved = (
        await api.put(`/teacher/lessons/${lessonId}/quiz/questions`, { questions: payload, aiGrading })
      ).data;
      const minutes = Number(timeLimitMin);
      const tries = Number(maxAttempts);
      await api.put(`/teacher/lessons/${lessonId}/quiz`, {
        passingScore,
        remedialLessonId: remedialLessonId || null,
        // Empty means no limit at all, which is not the same as a limit of zero.
        timeLimitSec: timeLimitMin.trim() && minutes > 0 ? Math.round(minutes * 60) : null,
        maxAttempts: maxAttempts.trim() && tries > 0 ? Math.min(50, Math.round(tries)) : null,
        shuffleQuestions: shuffle,
        aiGrading,
        aiThresholdPct,
        showAnswers,
      });
      return saved;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tquiz', lessonId] }),
  });

  const grade = useMutation({
    mutationFn: async ({ attemptId, scores }: { attemptId: string; scores: Record<string, number> }) =>
      (await api.post(`/teacher/quiz-attempts/${attemptId}/grade`, { scores })).data,
    onSuccess: () => { setGradingId(null); qc.invalidateQueries({ queryKey: ['tquiz', lessonId] }); },
  });

  if (isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;

  const setQ = (i: number, patch: Partial<Q>) =>
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));

  return (
    <div className="page">
      {/* Back to the lesson this quiz belongs to, with its panel still open —
          the builder passes the course along precisely so this can return
          there rather than dumping the teacher at the course list. */}
      <Link to={backTo} className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>{t('assess.builder.backCourses')}
      </Link>
      <PageHeader title={t('assess.builder.quizTitle')} subtitle={t('assess.builder.quizSubtitle')} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* Editor */}
        <div className="space-y-4">
          {questions.map((q, i) => (
            <div key={i} className="card">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">{i + 1}</span>
                  <select className="input py-1.5 text-sm" value={q.type}
                    onChange={(e) => setQuestions((qs) => qs.map((qq, j) => (j === i ? blankQ(e.target.value as Q['type']) : qq)))}>
                    <option value="MCQ">{t('assess.q.mcq')}</option>
                    <option value="TRUE_FALSE">{t('assess.q.trueFalse')}</option>
                    <option value="SHORT_ANSWER">{t('assess.q.short')}</option>
                  </select>
                </span>
                <button className="text-error/70 hover:text-error" onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>

              <textarea className="input mb-3 min-h-[3rem]" placeholder={t('assess.q.promptPlaceholder')}
                dir="auto" value={q.prompt} onChange={(e) => setQ(i, { prompt: e.target.value })} />

              {q.type !== 'SHORT_ANSWER' ? (
                <div className="space-y-2">
                  {/* How many answers the question asks for. Above the options,
                      because it changes what marking one of them means. */}
                  {q.type === 'MCQ' && q.options.length > 1 && (
                    <label className="mb-1 flex items-center gap-2 text-sm text-on-surface-variant">
                      {t('assess.q.howMany')}
                      <select
                        className="input w-auto py-1 text-sm"
                        value={q.maxSelections}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          // Narrowing the ask cannot leave more answers marked
                          // than it now allows.
                          setQ(i, { maxSelections: n, correctOptionIds: q.correctOptionIds.slice(0, n) });
                        }}
                      >
                        {Array.from({ length: q.options.length }, (_, n) => n + 1).map((n) => (
                          <option key={n} value={n}>
                            {n === 1 ? t('assess.q.howManyOne') : t('assess.q.howManyN', { count: n })}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {q.options.map((o) => {
                    const on = q.correctOptionIds.includes(o.id);
                    const multi = q.maxSelections > 1;
                    const mark = () => {
                      if (!multi) return setQ(i, { correctOptionIds: [o.id] });
                      if (on) return setQ(i, { correctOptionIds: q.correctOptionIds.filter((x) => x !== o.id) });
                      // Marking one more than the question asks for drops the
                      // oldest, so the count always matches what was chosen.
                      const next = [...q.correctOptionIds, o.id];
                      setQ(i, { correctOptionIds: next.slice(-q.maxSelections) });
                    };
                    return (
                      <label key={o.id} className="flex items-center gap-2">
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          className="accent-primary"
                          checked={on}
                          onChange={mark}
                        />
                        {q.type === 'TRUE_FALSE' ? (
                          /* Text, not a disabled input. A disabled field swallows
                             the click, so the only way to answer was to hit the
                             dot itself — which on a phone is a small target for
                             a word sitting right beside it. */
                          <span className="flex-1 cursor-pointer select-none rounded-lg bg-surface-container-low px-3 py-2 text-sm font-semibold">
                            {o.text}
                          </span>
                        ) : (
                          <input className="input py-1.5 text-sm" dir="auto" value={o.text}
                            placeholder={t('assess.q.optionPlaceholder')}
                            onChange={(e) => setQ(i, { options: q.options.map((oo) => (oo.id === o.id ? { ...oo, text: e.target.value } : oo)) })} />
                        )}
                        {q.type === 'MCQ' && q.options.length > 2 && (
                          <button type="button" className="text-outline hover:text-error"
                            onClick={() => setQ(i, {
                              options: q.options.filter((oo) => oo.id !== o.id),
                              correctOptionIds: q.correctOptionIds.filter((x) => x !== o.id),
                            })}>
                            <span className="material-symbols-outlined text-base">close</span>
                          </button>
                        )}
                      </label>
                    );
                  })}
                  {q.type === 'MCQ' && (
                    <button type="button" className="text-sm text-primary hover:underline"
                      onClick={() => setQ(i, { options: [...q.options, { id: rid(), text: '' }] })}>
                      + {t('assess.q.addOption')}
                    </button>
                  )}
                  <p className="text-xs text-outline">
                    {q.maxSelections > 1 ? t('assess.q.pickCorrectMulti') : t('assess.q.pickCorrect')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="rounded-lg bg-surface-container-low px-3 py-2 text-xs text-outline">{t('assess.q.manualNote')}</p>
                  <label className="block">
                    <span className="mb-1 block text-sm font-semibold text-on-surface-variant">
                      {t('assess.q.modelAnswer')}
                    </span>
                    <textarea className="input min-h-[4rem]" dir="auto" value={q.modelAnswer}
                      placeholder={t('assess.q.modelAnswerPh')}
                      onChange={(e) => setQ(i, { modelAnswer: e.target.value })} />
                    <span className="mt-1 block text-xs text-outline">{t('assess.q.modelAnswerHint')}</span>
                  </label>
                </div>
              )}

              <div className="mt-3 flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  {t('assess.q.points')}
                  {/* Held as text. Forcing it back to 1 on every keystroke meant
                      the box could never be emptied: clearing it to type "10"
                      put a 1 back and you got "110". */}
                  <input className="input w-16 py-1 text-sm" inputMode="numeric" value={q.points}
                    onChange={(e) => setQ(i, { points: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                    onBlur={() => setQ(i, { points: String(Math.max(1, Number(q.points) || 1)) })} />
                </label>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => setQuestions((qs) => [...qs, blankQ('MCQ')])}>+ {t('assess.q.mcq')}</button>
            <button className="btn-ghost" onClick={() => setQuestions((qs) => [...qs, blankQ('TRUE_FALSE')])}>+ {t('assess.q.trueFalse')}</button>
            <button className="btn-ghost" onClick={() => setQuestions((qs) => [...qs, blankQ('SHORT_ANSWER')])}>+ {t('assess.q.short')}</button>
          </div>
        </div>

        {/* Settings + attempts */}
        <aside className="space-y-4">
          <div className="card">
            <label className="mb-1 block text-sm font-bold">{t('assess.q.passingScore')}</label>
            <input className="input" inputMode="numeric" value={passingScore}
              onChange={(e) => setPassingScore(Math.min(100, Number(e.target.value.replace(/\D/g, '')) || 0))} />

            {/* Where a student goes when the answer is no. Sending them straight
                back to the paper they just failed teaches them nothing. */}
            {fromCourse && (
              <label className="mt-4 block">
                <span className="mb-1 block text-sm font-bold">{t('assess.builder.remedial')}</span>
                <select className="input" value={remedialLessonId}
                  onChange={(e) => setRemedialLessonId(e.target.value)}>
                  <option value="">{t('assess.builder.remedialNone')}</option>
                  {videoLessons.map((l) => (
                    <option key={l.id} value={l.id}>{l.title}</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-outline">{t('assess.builder.remedialHint')}</span>
              </label>
            )}
            {/* The three settings that were stored and never read: a time
                limit nothing counted, a shuffle nothing shuffled, and an
                attempt cap no teacher could reach. */}
            <div className="mt-4 space-y-3 border-t border-outline-variant/50 pt-4">
              <label className="block">
                <span className="mb-1 block text-sm font-bold">{t('assess.q.timeLimit')}</span>
                <input className="input" inputMode="numeric" placeholder={t('assess.q.noLimit')}
                  value={timeLimitMin}
                  onChange={(e) => setTimeLimitMin(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                <span className="mt-1 block text-xs text-outline">{t('assess.q.timeLimitHint')}</span>
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-bold">{t('assess.q.maxAttempts')}</span>
                <input className="input" inputMode="numeric" placeholder={t('assess.q.unlimited')}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value.replace(/\D/g, '').slice(0, 2))} />
                <span className="mt-1 block text-xs text-outline">{t('assess.q.maxAttemptsHint')}</span>
              </label>

              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 accent-primary" checked={shuffle}
                  onChange={(e) => setShuffle(e.target.checked)} />
                <span>
                  <span className="block font-bold">{t('assess.q.shuffle')}</span>
                  <span className="block text-xs text-on-surface-variant">{t('assess.q.shuffleHint')}</span>
                </span>
              </label>

              {/* A teacher who reuses one paper across intakes keeps the key to
                  themselves. Either way the student sees their score and their
                  own answers — and the answers never appear while they still
                  have an attempt to spend them on. */}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 accent-primary" checked={showAnswers}
                  onChange={(e) => setShowAnswers(e.target.checked)} />
                <span>
                  <span className="block font-bold">{t('assess.q.showAnswers')}</span>
                  <span className="block text-xs text-on-surface-variant">{t('assess.q.showAnswersHint')}</span>
                </span>
              </label>
            </div>

            {/* Marking the written answers against the model answer, instead of
                queueing every one of them for the teacher to read. */}
            {questions.some((q) => q.type === 'SHORT_ANSWER') && (
              <div className="mt-3 rounded-xl border border-outline-variant/60 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 accent-primary" checked={aiGrading}
                    onChange={(e) => setAiGrading(e.target.checked)} />
                  <span>
                    <span className="block font-bold">{t('assess.q.aiGrading')}</span>
                    <span className="block text-xs text-on-surface-variant">{t('assess.q.aiGradingHint')}</span>
                  </span>
                </label>
                {aiGrading && (
                  <label className="mt-3 block">
                    <span className="mb-1 block text-sm font-bold">
                      {t('assess.q.aiThreshold', { pct: aiThresholdPct })}
                    </span>
                    <input type="range" min={30} max={95} step={5} className="w-full accent-primary"
                      value={aiThresholdPct}
                      onChange={(e) => setAiThresholdPct(Number(e.target.value))} />
                    <span className="mt-1 block text-xs text-outline">{t('assess.q.aiThresholdHint')}</span>
                  </label>
                )}
                {/* Named, so the teacher knows which question to go and fix
                    rather than being told the paper is wrong somewhere. */}
                {unmarkable.length > 0 && (
                  <p className="mt-3 rounded-lg bg-error-container px-3 py-2 text-xs font-bold text-on-error-container">
                    {t('assess.q.aiNeedsModelAnswer', { n: unmarkable.length })}
                  </p>
                )}
              </div>
            )}

            <button className="btn-primary mt-4 w-full"
              disabled={save.isPending || !questions.length || unmarkable.length > 0}
              onClick={() => save.mutate()}>
              {save.isPending ? t('common.saving') : t('assess.q.saveQuiz')}
            </button>
            {save.isSuccess && <p className="mt-2 text-center text-sm text-secondary">{t('common.saved')}</p>}
            <ErrorNote error={save.error} />
          </div>

          <div className="card">
            <h3 className="mb-2 font-heading font-bold">{t('assess.q.attempts')}</h3>
            {!data?.attempts?.length ? (
              <p className="py-3 text-center text-sm text-outline">{t('assess.q.noAttempts')}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.attempts.map((a: any) => (
                  <li key={a.id} className="rounded-lg border border-outline-variant/40 p-2">
                    <div className="flex items-center justify-between">
                      <span className="truncate font-bold">{a.student?.user?.fullName}</span>
                      {a.needsManualGrading ? (
                        <Badge tone="warn">{t('assess.q.needsGrading')}</Badge>
                      ) : (
                        <Badge tone={a.passed ? 'neutral' : 'error'}>{a.scorePct}%</Badge>
                      )}
                    </div>
                    {a.needsManualGrading && (
                      gradingId === a.id ? (
                        <ManualGrade attempt={a} quizQuestions={data.questions ?? []} onCancel={() => setGradingId(null)}
                          onSubmit={(scores) => grade.mutate({ attemptId: a.id, scores })} pending={grade.isPending} />
                      ) : (
                        <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setGradingId(a.id)}>
                          {t('assess.q.gradeNow')}
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ManualGrade({ attempt, quizQuestions, onSubmit, onCancel, pending }: {
  attempt: any; quizQuestions: any[]; onSubmit: (scores: Record<string, number>) => void; onCancel: () => void; pending: boolean;
}) {
  const { t } = useTranslation();
  const shortQs = quizQuestions.filter((q: any) => q.type === 'SHORT_ANSWER');
  const answers = attempt.answers ?? {};
  const [scores, setScores] = useState<Record<string, number>>({});
  return (
    <div className="mt-2 space-y-2 border-t border-outline-variant/40 pt-2">
      {shortQs.length === 0 && <p className="text-xs text-outline">{t('assess.q.gradeGeneric')}</p>}
      {shortQs.map((q: any) => (
        <div key={q.id}>
          <p className="text-xs font-bold" dir="auto">{q.prompt}</p>
          <p className="rounded bg-surface-container-low px-2 py-1 text-xs" dir="auto">{answers[q.id] || '—'}</p>
          <input className="input mt-1 w-full py-1 text-xs" placeholder={t('assess.q.awardPoints', { max: q.points })}
            inputMode="numeric" onChange={(e) => setScores((s) => ({ ...s, [q.id]: Number(e.target.value.replace(/\D/g, '')) || 0 }))} />
        </div>
      ))}
      <div className="flex gap-2">
        <button className="btn-primary flex-1 py-1.5 text-xs" disabled={pending} onClick={() => onSubmit(scores)}>{t('assess.q.finalize')}</button>
        <button className="btn-ghost py-1.5 text-xs" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { resolveError } from '../../lib/errorMessage';
import { GAMIFICATION_KEY } from '../../lib/gamification';
import { RewardSummary } from '../../components/gamification/RewardBurst';
import { Badge, ErrorNote, Spinner } from '../../components/ui';

/** mm:ss, the only format a countdown is ever read in. */
function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Which way a question reads, from its own first letter.
 *
 * The app is right-to-left and many papers are English. With the page's
 * direction inherited, an English option drew its radio at the far right and
 * its text pushed against it — the jagged column in every English exam. A
 * question now lays itself out in the direction its text is written in.
 */
function dirOf(text: string | undefined): 'rtl' | 'ltr' {
  const m = /[A-Za-z֐-ࣿ]/.exec(text ?? '');
  return m && /[֐-ࣿ]/.test(m[0]) ? 'rtl' : 'ltr';
}

/** A sitting's identity — see SubmitAttemptDto.submitKey. */
function newSittingKey(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '');
}

type Answers = Record<string, string | string[]>;

const isAnswered = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;

export default function QuizTakerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Answers>({});
  const [result, setResult] = useState<any>(null);
  /** Whether their previous answers have been read back into the form yet. */
  const restored = useRef(false);

  const { data: quiz, isLoading } = useQuery({
    queryKey: ['quiz', lessonId],
    queryFn: async () => (await api.get(`/lessons/${lessonId}/quiz`)).data,
  });

  /**
   * One key per sitting, sent with every try at submitting it. However many
   * times the button is pressed or the request is retried, the server records
   * one attempt and answers the rest with its result. A retake is a new
   * sitting and gets a new key.
   */
  const sittingKey = useRef(newSittingKey());
  /** Set the instant a submission starts, before React re-renders — a second
   *  tap in the same frame must not start a second request. */
  const sending = useRef(false);

  const submit = useMutation({
    mutationFn: async () => {
      // A copy of this submission still being marked answers 409; it will be
      // done in a moment, and asking again with the same key returns its
      // result rather than recording anything new.
      for (let tries = 0; ; tries++) {
        try {
          return (
            await api.post(`/lessons/${lessonId}/quiz/attempts`, {
              answers,
              submitKey: sittingKey.current,
            })
          ).data;
        } catch (e) {
          if (resolveError(e).code !== 'SUBMISSION_IN_PROGRESS' || tries >= 15) throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    },
    onSuccess: (data) => {
      setResult(data);
      // A retake that has just been handed in is a result, not a paper to sit.
      setRetaking(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      qc.invalidateQueries({ queryKey: ['quiz', lessonId] });
      if (data?.gamification?.awarded) {
        qc.invalidateQueries({ queryKey: GAMIFICATION_KEY });
        qc.invalidateQueries({ queryKey: ['progress-summary'] });
      }
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  const send = () => {
    if (sending.current || submit.isPending) return;
    sending.current = true;
    submit.mutate();
  };

  /**
   * Coming back to a paper you have already sat lands on your result, not on
   * a blank paper with a running clock. `retaking` is the student saying, on
   * purpose, that they want another go.
   */
  const [retaking, setRetaking] = useState(false);
  const sat = quiz?.lastAttempt ?? null;
  const outcome = result ?? sat;
  const done = !!outcome && !retaking;

  /** Their own paper, read back once — after that the inputs are theirs. */
  useEffect(() => {
    if (restored.current || retaking) return;
    const prior = quiz?.lastAttempt?.answers;
    if (!prior || !Object.keys(prior).length) return;
    restored.current = true;
    setAnswers(prior);
  }, [quiz?.lastAttempt?.answers, retaking]);

  /**
   * The countdown. The deadline and the "now" it is measured against are the
   * server's; only the ticking is local. The server checks the same deadline
   * on arrival — a countdown in a browser is a courtesy.
   */
  const deadline = quiz?.deadlineAt ? new Date(quiz.deadlineAt).getTime() : null;
  const skew = quiz?.serverNow ? Date.now() - new Date(quiz.serverNow).getTime() : 0;
  const [msLeft, setMsLeft] = useState<number | null>(null);
  const autoSent = useRef(false);

  useEffect(() => {
    if (deadline == null || done) return;
    const tick = () => setMsLeft(Math.max(0, deadline + skew - Date.now()));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [deadline, skew, done]);

  useEffect(() => {
    // Sent once, at zero, and only if something is answered — an empty paper
    // submitted automatically would spend the attempt for nothing.
    if (msLeft !== 0 || done || autoSent.current || submit.isPending) return;
    autoSent.current = true;
    if (Object.values(answers).some(isAnswered)) send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msLeft, done, submit.isPending, answers]);

  if (isLoading)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!quiz) return null;

  const back = (
    <Link
      to={`/course/${courseId}`}
      className="mb-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>
      {t('assess.take.backCourse')}
    </Link>
  );

  if (done) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {back}
        <ResultView
          quiz={quiz}
          outcome={outcome}
          justSubmitted={!!result}
          answers={answers}
          lessonId={lessonId!}
          courseId={courseId!}
          onRetake={() => {
            restored.current = true; // a retake starts from a blank paper
            sittingKey.current = newSittingKey();
            autoSent.current = false;
            setRetaking(true);
            setResult(null);
            setAnswers({});
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {back}
      <ExamSheet
        quiz={quiz}
        answers={answers}
        setAnswers={setAnswers}
        msLeft={msLeft}
        submitting={submit.isPending}
        onSubmit={send}
      />
      <ErrorNote error={submit.error} />
      {submit.isPending && <SubmittingOverlay />}
    </div>
  );
}

// ── taking the paper ──────────────────────────────────────────────────────

/**
 * The paper, one question at a time.
 *
 * It used to be every question on one long page, which on a twenty-question
 * paper is a scroll where a skipped question is invisible until the end. One
 * question per screen, a map of all of them beside it — green when answered,
 * empty when not — and a submit that says exactly which ones are still empty.
 */
function ExamSheet({
  quiz,
  answers,
  setAnswers,
  msLeft,
  submitting,
  onSubmit,
}: {
  quiz: any;
  answers: Answers;
  setAnswers: React.Dispatch<React.SetStateAction<Answers>>;
  msLeft: number | null;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const questions: any[] = quiz.questions;
  const total = questions.length;
  const [at, setAt] = useState(0);
  const q = questions[Math.min(at, total - 1)];
  const answeredCount = questions.filter((x) => isAnswered(answers[x.id])).length;
  const missing = questions
    .map((x, i) => (isAnswered(answers[x.id]) ? null : i + 1))
    .filter((n): n is number => n != null);
  const top = useRef<HTMLDivElement>(null);

  const go = (i: number) => {
    setAt(Math.max(0, Math.min(total - 1, i)));
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const confirmSubmit = async () => {
    const ok = await askConfirm(
      missing.length
        ? t('assess.take.confirmMissing', {
            list: missing.join('، '),
            count: missing.length,
          })
        : t('assess.take.confirmAll'),
      {
        title: t('assess.take.confirmTitle'),
        confirmLabel: t('assess.take.confirmAction'),
        cancelLabel: t('assess.take.keepAnswering'),
        danger: missing.length > 0,
      },
    );
    if (ok) onSubmit();
    else if (missing.length) go(missing[0] - 1);
  };

  return (
    <div ref={top} className="scroll-mt-24">
      {/* What this is, how far along, how long is left. */}
      <header className="card mb-5 flex flex-wrap items-center gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary-fixed text-on-primary-fixed">
          <span className="material-symbols-outlined text-2xl">quiz</span>
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-extrabold">{t('assess.take.quizTitle')}</h1>
          <p className="text-sm text-outline">
            {t('assess.take.passNeeded', { pct: quiz.passingScore })} ·{' '}
            {t('assess.take.answeredOf', { done: answeredCount, total })}
          </p>
        </div>
        {msLeft != null && (
          <div
            className={`flex items-center gap-2 rounded-xl border-2 px-3 py-1.5 ${
              msLeft <= 60_000 ? 'border-error text-error' : 'border-outline-variant/60'
            }`}
          >
            <span className="material-symbols-outlined">timer</span>
            <span className="font-heading text-xl font-extrabold tabular-nums" dir="ltr">
              {clock(msLeft)}
            </span>
          </div>
        )}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${total ? (answeredCount / total) * 100 : 0}%` }}
          />
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        {/* The question */}
        <section className="card flex min-h-[22rem] flex-col">
          <div className="mb-4 flex items-center justify-between gap-3 text-sm">
            <span className="font-bold text-primary">
              {t('assess.take.questionOf', { n: at + 1, total })}
            </span>
            <span className="text-outline">{t('assess.q.pointsN', { n: q.points })}</span>
          </div>
          <QuestionBody
            q={q}
            value={answers[q.id]}
            onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
          />
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-outline-variant/50 pt-4">
            <button
              type="button"
              className="btn-secondary px-4 py-2"
              disabled={at === 0}
              onClick={() => go(at - 1)}
            >
              <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">
                arrow_back
              </span>
              {t('assess.take.prev')}
            </button>
            {at < total - 1 ? (
              <button type="button" className="btn-primary px-5 py-2" onClick={() => go(at + 1)}>
                {t('assess.take.next')}
                <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">
                  arrow_forward
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary px-5 py-2"
                disabled={submitting}
                onClick={confirmSubmit}
              >
                <span className="material-symbols-outlined text-[18px]">task_alt</span>
                {t('assess.take.submit')}
              </button>
            )}
          </div>
        </section>

        {/* Every question, at a glance */}
        <aside className="card h-fit lg:sticky lg:top-24">
          <p className="mb-3 font-heading font-bold">{t('assess.take.navTitle')}</p>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 lg:grid-cols-5">
            {questions.map((x, i) => {
              const answered = isAnswered(answers[x.id]);
              const current = i === at;
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => go(i)}
                  aria-current={current ? 'step' : undefined}
                  aria-label={t('assess.take.questionOf', { n: i + 1, total })}
                  className={`grid aspect-square place-items-center rounded-full border-2 text-sm font-bold tabular-nums transition ${
                    answered
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-outline-variant text-on-surface-variant hover:border-primary'
                  } ${current ? 'ring-4 ring-primary/30' : ''}`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full bg-emerald-500" />
              {t('assess.take.legendAnswered', { count: answeredCount })}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-outline-variant" />
              {t('assess.take.legendEmpty', { count: total - answeredCount })}
            </span>
          </div>
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            disabled={submitting}
            onClick={confirmSubmit}
          >
            {t('assess.take.submit')}
          </button>
        </aside>
      </div>
    </div>
  );
}

/** One question's text and inputs, in the direction the question is written. */
function QuestionBody({
  q,
  value,
  onChange,
}: {
  q: any;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const { t } = useTranslation();
  const dir = dirOf(q.prompt);
  const many = (q.maxSelections ?? 1) > 1;
  return (
    <div dir={dir} className="mb-6">
      <p className="mb-5 whitespace-pre-line text-lg font-bold leading-relaxed">{q.prompt}</p>
      {q.type === 'SHORT_ANSWER' ? (
        <textarea
          className="input min-h-[8rem]"
          dir="auto"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('assess.take.yourAnswer')}
        />
      ) : (
        <div className="space-y-2.5">
          {many && (
            <p className="text-xs font-semibold text-primary">
              {t('assess.take.pickN', { count: q.maxSelections })}
            </p>
          )}
          {q.options.map((o: any) => {
            const chosen = Array.isArray(value) ? value.includes(o.id) : value === o.id;
            const toggle = () => {
              if (!many) return onChange(o.id);
              const cur = Array.isArray(value) ? value : value ? [value] : [];
              onChange(
                cur.includes(o.id)
                  ? cur.filter((x) => x !== o.id)
                  : // Past the limit the oldest choice makes way.
                    [...cur, o.id].slice(-q.maxSelections),
              );
            };
            return (
              <label
                key={o.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 px-4 py-3 transition ${
                  chosen
                    ? 'border-primary bg-primary-fixed/40'
                    : 'border-outline-variant/60 hover:border-outline'
                }`}
              >
                <input
                  type={many ? 'checkbox' : 'radio'}
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  name={q.id}
                  checked={chosen}
                  onChange={toggle}
                />
                <span className="min-w-0 flex-1 text-start leading-relaxed">{o.text}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The moment between pressing submit and the result: nothing else to press. */
function SubmittingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
    >
      <div className="card flex max-w-sm flex-col items-center gap-3 p-8 text-center">
        <Spinner />
        <p className="font-heading text-lg font-bold">{t('assess.take.submitting')}</p>
        <p className="text-sm text-on-surface-variant">{t('assess.take.submittingHint')}</p>
      </div>
    </div>
  );
}

// ── after ─────────────────────────────────────────────────────────────────

function ResultView({
  quiz,
  outcome,
  justSubmitted,
  answers,
  lessonId,
  courseId,
  onRetake,
}: {
  quiz: any;
  outcome: any;
  justSubmitted: boolean;
  answers: Answers;
  lessonId: string;
  courseId: string;
  onRetake: () => void;
}) {
  const { t } = useTranslation();
  const [reviewing, setReviewing] = useState(false);
  const reviewById = useMemo(() => {
    const out: Record<string, any> = {};
    ((outcome?.review?.length ? outcome.review : quiz?.review) ?? []).forEach(
      (r: any) => (out[r.id] = r),
    );
    return out;
  }, [outcome, quiz]);
  const pending = outcome.needsManualGrading || outcome.scorePct == null;

  return (
    <>
      <div
        className={`card mb-6 border-2 text-center ${
          pending ? 'border-warn' : outcome.passed ? 'border-emerald-500' : 'border-error'
        }`}
      >
        {justSubmitted && (
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-bold text-emerald-700 dark:text-emerald-300">
            <span className="material-symbols-outlined text-base">check_circle</span>
            {t('assess.take.submittedTitle')}
          </p>
        )}
        {pending ? (
          <>
            <span className="material-symbols-outlined mb-1 block text-5xl text-warn">
              hourglass_top
            </span>
            <p className="font-heading text-xl font-bold">{t('assess.take.pendingManual')}</p>
            <p className="mt-1 text-sm text-outline">{t('assess.take.pendingManualHint')}</p>
          </>
        ) : (
          <>
            <p
              className={`font-heading text-5xl font-extrabold ${
                outcome.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-error'
              }`}
              dir="ltr"
            >
              {outcome.scorePct}%
            </p>
            <p className="mt-1 text-lg font-bold">
              {outcome.passed ? t('assess.take.passed') : t('assess.take.failed')}
            </p>
            {!justSubmitted && (
              <p className="mt-1 text-sm text-outline">{t('assess.take.alreadySat')}</p>
            )}
          </>
        )}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" className="btn-secondary" onClick={() => setReviewing((v) => !v)}>
            <span className="material-symbols-outlined text-base">
              {reviewing ? 'visibility_off' : 'fact_check'}
            </span>
            {reviewing ? t('assess.take.hideReview') : t('assess.take.showReview')}
          </button>
          {quiz.canSitAgain && !outcome.needsManualGrading && (
            <button type="button" className="btn-ghost" onClick={onRetake}>
              <span className="material-symbols-outlined text-base">refresh</span>
              {t('assess.take.retake')}
            </button>
          )}
          <Link to={`/course/${courseId}`} className="btn-primary">
            {t('assess.take.backCourse')}
          </Link>
        </div>
        {quiz.canSitAgain && !outcome.needsManualGrading && (
          <p className="mt-2 text-xs text-outline">
            {quiz.attemptsRemaining != null
              ? t('assess.take.retakeHintCounted', { count: quiz.attemptsRemaining })
              : t('assess.take.retakeHint')}
          </p>
        )}
      </div>

      {/* What the attempt earned — for a failed attempt too: finishing is work. */}
      {justSubmitted && outcome?.gamification?.awarded && (
        <div className="mb-6">
          <RewardSummary outcome={outcome.gamification} />
        </div>
      )}

      {reviewing && (
        <div className="space-y-4">
          {quiz.questions.map((q: any, i: number) => (
            <ReviewCard
              key={q.id}
              q={q}
              index={i}
              answer={answers[q.id]}
              rev={reviewById[q.id]}
              ai={outcome.aiFeedback?.[q.id]}
              lessonId={lessonId}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** One question after the paper is in: what was chosen, and — when the
 *  teacher allows it and no attempt is left to spend it on — the key. */
function ReviewCard({
  q,
  index,
  answer,
  rev,
  ai,
  lessonId,
}: {
  q: any;
  index: number;
  answer: string | string[] | undefined;
  rev: any;
  ai: { awarded: boolean; similarityPct: number; reason?: string } | undefined;
  lessonId: string;
}) {
  const { t } = useTranslation();
  const key: string[] =
    rev?.correctOptionIds ?? (rev?.correctOptionId ? [rev.correctOptionId] : []);
  return (
    <div className="card" dir={dirOf(q.prompt)}>
      <p className="mb-3 font-bold leading-relaxed">
        <span className="me-1 text-primary">{index + 1}.</span>
        {q.prompt}
        <span className="ms-2 text-xs font-normal text-outline">
          ({t('assess.q.pointsN', { n: q.points })})
        </span>
      </p>
      {q.type === 'SHORT_ANSWER' ? (
        <p className="rounded-xl border border-outline-variant/60 px-4 py-3 text-sm" dir="auto">
          {(answer as string)?.trim() || (
            <span className="text-outline">{t('assess.take.noAnswer')}</span>
          )}
        </p>
      ) : (
        <div className="space-y-2">
          {q.options.map((o: any) => {
            const chosen = Array.isArray(answer) ? answer.includes(o.id) : answer === o.id;
            const isCorrect = key.includes(o.id);
            const wrong = chosen && key.length > 0 && !isCorrect;
            return (
              <div
                key={o.id}
                className={`flex items-start gap-3 rounded-xl border px-4 py-2.5 text-sm ${
                  isCorrect
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : wrong
                      ? 'border-error bg-error-container/30'
                      : chosen
                        ? 'border-primary bg-primary-fixed/40'
                        : 'border-outline-variant/50'
                }`}
              >
                <span className="material-symbols-outlined mt-px text-base">
                  {chosen ? 'radio_button_checked' : 'radio_button_unchecked'}
                </span>
                <span className="min-w-0 flex-1 text-start">{o.text}</span>
                {isCorrect && (
                  <span className="material-symbols-outlined text-base text-emerald-600">
                    check_circle
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {ai && (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-xs ${
            ai.awarded
              ? 'bg-secondary-container/40 text-on-secondary-container'
              : 'bg-error-container/40 text-on-error-container'
          }`}
          dir="auto"
        >
          <span className="font-bold">
            {t(ai.awarded ? 'assess.take.aiAwarded' : 'assess.take.aiNotAwarded', {
              pct: ai.similarityPct,
            })}
          </span>
          {ai.reason && <span className="block">{ai.reason}</span>}
        </p>
      )}
      {rev?.modelAnswer && (
        <p
          className="mt-2 rounded-lg border border-secondary/30 bg-secondary-container/25 px-3 py-2 text-xs"
          dir="auto"
        >
          <span className="font-bold">{t('assess.q.modelAnswer')}: </span>
          {rev.modelAnswer}
        </p>
      )}
      {rev?.explanation && (
        <p
          className="mt-2 rounded-lg bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant"
          dir="auto"
        >
          <span className="font-bold">{t('assess.take.explanation')}: </span>
          {rev.explanation}
        </p>
      )}
      {q.type !== 'SHORT_ANSWER' && <ReportQuestion lessonId={lessonId} questionId={q.id} />}
      {!key.length && q.type !== 'SHORT_ANSWER' && (
        <Badge tone="neutral">{t('assess.take.keyHidden')}</Badge>
      )}
    </div>
  );
}

/**
 * "This question is wrong." A key is typed by hand and is sometimes typed
 * wrong; the report lands in the teacher's marking screen against the
 * question, next to what the rest of the class chose.
 */
function ReportQuestion({ lessonId, questionId }: { lessonId: string; questionId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/lessons/${lessonId}/quiz/questions/${questionId}/report`, {
          note: note.trim() || undefined,
        })
      ).data,
  });

  if (send.isSuccess) {
    return <p className="mt-2 text-xs font-bold text-secondary">{t('grading.reportSent')}</p>;
  }
  if (!open) {
    return (
      <button
        type="button"
        className="mt-2 flex items-center gap-1 text-xs text-outline hover:text-error hover:underline"
        onClick={() => setOpen(true)}
      >
        <span className="material-symbols-outlined text-[16px]">flag</span>
        {t('grading.reportQuestion')}
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-xl border border-outline-variant/60 p-3">
      <textarea
        className="input min-h-16 text-sm"
        dir="auto"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('grading.reportNotePh')}
      />
      <div className="mt-2 flex gap-2">
        <button
          className="btn-primary py-1.5 text-xs"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? t('common.saving') : t('grading.send')}
        </button>
        <button className="btn-ghost py-1.5 text-xs" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </button>
      </div>
      <ErrorNote error={send.error} />
    </div>
  );
}

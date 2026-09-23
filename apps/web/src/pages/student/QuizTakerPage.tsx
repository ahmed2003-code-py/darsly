import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { GAMIFICATION_KEY } from '../../lib/gamification';
import { RewardSummary } from '../../components/gamification/RewardBurst';
import { Badge, ErrorNote, Spinner } from '../../components/ui';

/** mm:ss, the only format a countdown is ever read in. */
function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function QuizTakerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [result, setResult] = useState<any>(null);
  /** Whether their previous answers have been read back into the form yet. */
  const restored = useRef(false);

  const { data: quiz, isLoading } = useQuery({
    queryKey: ['quiz', lessonId],
    queryFn: async () => (await api.get(`/lessons/${lessonId}/quiz`)).data,
  });

  const submit = useMutation({
    mutationFn: async () =>
      (await api.post(`/lessons/${lessonId}/quiz/attempts`, { answers })).data,
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ['quiz', lessonId] });
      if (data?.gamification?.awarded) {
        qc.invalidateQueries({ queryKey: GAMIFICATION_KEY });
        qc.invalidateQueries({ queryKey: ['progress-summary'] });
      }
    },
  });

  /**
   * Coming back to a paper you have already sat.
   *
   * The page used to open on a blank paper with a running clock whatever had
   * happened before — so a student who had finished and closed it came back to
   * what looked like a fresh exam, and (once the clock was real) opening it
   * spent another attempt. What they should land on is their result.
   *
   * `retaking` is the student saying, on purpose, that they want another go.
   * Nothing here decides that for them.
   */
  const [retaking, setRetaking] = useState(false);
  const sat = quiz?.lastAttempt ?? null;
  // Their result: the one just submitted, or the one already on file.
  const outcome = result ?? sat;
  const done = !!outcome && !retaking;

  /**
   * Show them their own paper, once.
   *
   * Their answers come back with the quiz, so a finished paper renders filled
   * in rather than empty. Copied into state a single time — after that the
   * inputs belong to the student, and a refetch must not overwrite what they
   * are in the middle of typing.
   */
  useEffect(() => {
    if (restored.current || retaking) return;
    const prior = quiz?.lastAttempt?.answers;
    if (!prior || !Object.keys(prior).length) return;
    restored.current = true;
    setAnswers(prior);
  }, [quiz?.lastAttempt?.answers, retaking]);

  /**
   * The countdown on a timed paper.
   *
   * The deadline is the server's, and so is the "now" it was measured against:
   * a device with a wrong clock would otherwise read minutes left on a paper
   * that closed, or close one that had not. Only the ticking is local.
   *
   * This draws the clock and sends the paper when it reaches zero. It is not
   * what enforces the limit — the server checks the same deadline on arrival,
   * because a countdown in a browser is a courtesy and can be turned off.
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
    // Sent once, at zero, and only if they have answered something — an empty
    // paper submitted automatically would spend the attempt for nothing.
    if (msLeft !== 0 || done || autoSent.current || submit.isPending) return;
    autoSent.current = true;
    if (Object.keys(answers).length) submit.mutate();
  }, [msLeft, done, submit, answers]);

  if (isLoading)
    return (
      <div className="grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!quiz) return null;

  const reviewById: Record<string, any> = {};
  // The key, from the submission that just happened or from the paper on file.
  // Empty when the teacher keeps the answers to themselves, or while the
  // student still has an attempt they could spend them on.
  ((result?.review?.length ? result.review : quiz?.review) ?? []).forEach(
    (r: any) => (reviewById[r.id] = r),
  );
  const answered = Object.keys(answers).length;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
      <Link
        to={`/course/${courseId}`}
        className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>
        {t('assess.take.backCourse')}
      </Link>
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-on-primary-fixed">
          <span className="material-symbols-outlined text-2xl">quiz</span>
        </span>
        <div>
          <h1 className="font-heading text-2xl font-extrabold">{t('assess.take.quizTitle')}</h1>
          <p className="text-sm text-outline">
            {t('assess.take.passNeeded', { pct: quiz.passingScore })}
          </p>
        </div>
      </div>

      {/* Result banner */}
      {done && (
        <div
          className={`card mb-6 text-center ${outcome.passed ? 'border-secondary' : outcome.needsManualGrading ? 'border-warn' : 'border-error'} border-2`}
        >
          {outcome.needsManualGrading ? (
            <>
              <span className="material-symbols-outlined mb-1 text-4xl text-warn">
                hourglass_top
              </span>
              <p className="font-heading text-lg font-bold">{t('assess.take.pendingManual')}</p>
              <p className="text-sm text-outline">{t('assess.take.pendingManualHint')}</p>
            </>
          ) : (
            <>
              <p
                className={`font-heading text-4xl font-extrabold ${outcome.passed ? 'text-secondary' : 'text-error'}`}
              >
                {outcome.scorePct}%
              </p>
              <p className="mt-1 font-bold">
                {outcome.passed ? t('assess.take.passed') : t('assess.take.failed')}
              </p>
              {/* Said plainly, because arriving at a paper you have already sat
                  and being shown a blank one is what this replaces. */}
              {!result && (
                <p className="mt-1 text-sm text-outline">{t('assess.take.alreadySat')}</p>
              )}
            </>
          )}

          {/* Another go, only when there is something to gain from one: the
              server decides that (attempts left, and not already full marks)
              and the page does not second-guess it. An attempt cap of one never
              advertises a second. */}
          {quiz.canSitAgain && !outcome.needsManualGrading && (
            <div className="mt-4">
              <button
                className="btn-ghost"
                onClick={() => {
                  restored.current = true; // a retake starts from a blank paper
                  setRetaking(true);
                  setResult(null);
                  setAnswers({});
                }}
              >
                <span className="material-symbols-outlined text-base">refresh</span>
                {t('assess.take.retake')}
              </button>
              <p className="mt-1 text-xs text-outline">
                {quiz.attemptsRemaining != null
                  ? t('assess.take.retakeHintCounted', { count: quiz.attemptsRemaining })
                  : t('assess.take.retakeHint')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* What the attempt earned. Shown for a failed attempt too — finishing a
          quiz is work, and the page should say so rather than only rewarding
          the students who already knew the answers. */}
      {done && result?.gamification?.awarded && (
        <div className="mb-6">
          <RewardSummary outcome={result.gamification} />
        </div>
      )}

      {/* The clock. Turns urgent under a minute, because a countdown nobody
          notices is the same as no countdown. */}
      {!done && msLeft != null && (
        <div
          className={`card mb-6 flex items-center justify-center gap-2 border-2 ${
            msLeft <= 60_000 ? 'border-error text-error' : 'border-outline-variant/60'
          }`}
        >
          <span className="material-symbols-outlined">timer</span>
          <span className="font-heading text-2xl font-extrabold tabular-nums">{clock(msLeft)}</span>
          <span className="text-sm text-on-surface-variant">{t('assess.take.timeLeft')}</span>
        </div>
      )}

      {/* Prior attempt (before submitting again) */}
      {!done && quiz.lastAttempt && (
        <div className="card mb-6 flex items-center justify-between">
          <span className="text-sm text-on-surface-variant">{t('assess.take.lastAttempt')}</span>
          {/* A score of null is a paper still being marked, not a score of
              nothing — it used to render as a bare "%". */}
          {quiz.lastAttempt.needsManualGrading || quiz.lastAttempt.scorePct == null ? (
            <Badge tone="warn">{t('assess.q.needsGrading')}</Badge>
          ) : (
            <Badge tone={quiz.lastAttempt.passed ? 'teal' : 'error'}>
              {quiz.lastAttempt.scorePct}%
            </Badge>
          )}
        </div>
      )}

      <div className="space-y-4">
        {quiz.questions.map((q: any, i: number) => {
          const rev = reviewById[q.id];
          return (
            <div key={q.id} className="card">
              <p className="mb-3 font-bold" dir="auto">
                <span className="me-1 text-primary">{i + 1}.</span>
                {q.prompt}
                <span className="ms-2 text-xs font-normal text-outline">
                  ({t('assess.q.pointsN', { n: q.points })})
                </span>
              </p>

              {q.type === 'SHORT_ANSWER' ? (
                <textarea
                  className="input min-h-[4rem]"
                  dir="auto"
                  disabled={done}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  placeholder={t('assess.take.yourAnswer')}
                />
              ) : (
                <div className="space-y-2">
                  {/* A question may ask for more than one. Saying so is the
                      difference between "pick the right one" and "pick two",
                      which the options alone cannot tell you. */}
                  {(q.maxSelections ?? 1) > 1 && !done && (
                    <p className="text-xs font-semibold text-primary">
                      {t('assess.take.pickN', { count: q.maxSelections })}
                    </p>
                  )}
                  {q.options.map((o: any) => {
                    const picked = answers[q.id];
                    const many = (q.maxSelections ?? 1) > 1;
                    const chosen = Array.isArray(picked) ? picked.includes(o.id) : picked === o.id;
                    const key: string[] =
                      rev?.correctOptionIds ?? (rev?.correctOptionId ? [rev.correctOptionId] : []);
                    const isCorrect = done && key.includes(o.id);
                    const isWrongChosen = done && chosen && !isCorrect;
                    const toggle = () => {
                      if (!many) return setAnswers((a) => ({ ...a, [q.id]: o.id }));
                      const cur = Array.isArray(picked) ? picked : picked ? [picked] : [];
                      const next = cur.includes(o.id)
                        ? cur.filter((x) => x !== o.id)
                        : // Past the limit the oldest choice makes way, so the
                          // student is never stuck having to untick first.
                          [...cur, o.id].slice(-q.maxSelections);
                      setAnswers((a) => ({ ...a, [q.id]: next }));
                    };
                    return (
                      <label
                        key={o.id}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                          isCorrect
                            ? 'border-secondary bg-secondary-container/40'
                            : isWrongChosen
                              ? 'border-error bg-error-container/30'
                              : chosen
                                ? 'border-primary bg-primary-fixed/40'
                                : 'border-outline-variant/50'
                        }`}
                      >
                        <input
                          type={many ? 'checkbox' : 'radio'}
                          className="accent-primary"
                          name={q.id}
                          disabled={done}
                          checked={chosen}
                          onChange={toggle}
                        />
                        <span dir="auto">{o.text}</span>
                        {isCorrect && (
                          <span className="material-symbols-outlined ms-auto text-base text-secondary">
                            check_circle
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Why a written answer scored what it did. A bare number on an
                  essay is not something a student can learn from or argue
                  with, and the teacher can still regrade it. */}
              {done && outcome.aiFeedback?.[q.id] && (
                <p
                  className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                    outcome.aiFeedback[q.id].awarded
                      ? 'bg-secondary-container/40 text-on-secondary-container'
                      : 'bg-error-container/40 text-on-error-container'
                  }`}
                  dir="auto"
                >
                  <span className="font-bold">
                    {t(
                      outcome.aiFeedback[q.id].awarded
                        ? 'assess.take.aiAwarded'
                        : 'assess.take.aiNotAwarded',
                      {
                        pct: outcome.aiFeedback[q.id].similarityPct,
                      },
                    )}
                  </span>
                  {outcome.aiFeedback[q.id].reason && (
                    <span className="block">{outcome.aiFeedback[q.id].reason}</span>
                  )}
                </p>
              )}

              {done && rev?.modelAnswer && (
                <p
                  className="mt-2 rounded-lg border border-secondary/30 bg-secondary-container/25 px-3 py-2 text-xs"
                  dir="auto"
                >
                  <span className="font-bold">{t('assess.q.modelAnswer')}: </span>
                  {rev.modelAnswer}
                </p>
              )}

              {done && rev?.explanation && (
                <p
                  className="mt-2 rounded-lg bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant"
                  dir="auto"
                >
                  <span className="font-bold">{t('assess.take.explanation')}: </span>
                  {rev.explanation}
                </p>
              )}

              {/* The one thing a student can do about a key with the wrong
                  letter in it. Only once the paper is sat and only on a keyed
                  question — there is nothing to be wrong about in an essay. */}
              {done && q.type !== 'SHORT_ANSWER' && lessonId && (
                <ReportQuestion lessonId={lessonId} questionId={q.id} />
              )}
            </div>
          );
        })}
      </div>

      <ErrorNote error={submit.error} />
      {!done ? (
        <button
          className="btn-primary mt-6 w-full"
          disabled={submit.isPending || answered < quiz.questions.length}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? t('common.saving') : t('assess.take.submit')}
        </button>
      ) : (
        <Link to={`/course/${courseId}`} className="btn-primary mt-6 block w-full text-center">
          {t('assess.take.backCourse')}
        </Link>
      )}
    </div>
  );
}

/**
 * "This question is wrong."
 *
 * A key is typed in by hand, so a key is sometimes typed in wrong, and the
 * people who find out are the students who answered correctly and were marked
 * down for it. Before this the only route was a message to the teacher — if
 * that teacher accepted messages — and nothing tied the complaint to the
 * question it was about. It lands in the teacher's marking screen instead,
 * against the question, next to what the rest of the class chose.
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

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { GAMIFICATION_KEY } from '../../lib/gamification';
import {
  AnswerFeedback,
  AttemptState,
  ChallengeLeaderboardRow,
  ChallengeResult,
  useChallengeDetail,
} from '../../lib/challenges';
import { RewardSummary } from '../../components/gamification/RewardBurst';
import { Badge, ErrorNote, Spinner } from '../../components/ui';

const EASE = [0.16, 1, 0.3, 1] as const;

/** mm:ss — the only format a countdown is ever read in. */
function clock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function ChallengePlayPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();

  const { data: detail, isLoading: loadingDetail } = useChallengeDetail(id);
  const [attempt, setAttempt] = useState<AttemptState | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [result, setResult] = useState<ChallengeResult | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboard, setLeaderboard] = useState<ChallengeLeaderboardRow[] | null>(null);
  const resumed = useRef(false);

  // Resume an in-progress attempt automatically — a reload must never lose
  // where the student was (§11).
  useEffect(() => {
    if (resumed.current || !detail?.openAttemptId || attempt) return;
    resumed.current = true;
    api.get(`/challenges/${id}/attempts/${detail.openAttemptId}`).then(({ data }) => {
      setAttempt(data);
      setIndex(data.answeredCount);
    });
  }, [detail, id, attempt]);

  const start = useMutation({
    mutationFn: async () => (await api.post(`/challenges/${id}/attempts`)).data as AttemptState,
    onSuccess: (data) => { setAttempt(data); setIndex(data.answeredCount); setResult(null); },
  });

  // Takes the answer explicitly rather than reading `selected` from closure —
  // it fires in the same tick as the tap that sets `selected`, before that
  // state update has landed, so relying on the state here would submit
  // whatever was picked *last* time instead of just now.
  const answer = useMutation({
    mutationFn: async ({ questionId, optionIds }: { questionId: string; optionIds: string[] }) =>
      (await api.post(`/challenges/${id}/attempts/${attempt!.attemptId}/answers`, { questionId, selectedOptionIds: optionIds }))
        .data as AnswerFeedback,
    onSuccess: (data) => setFeedback(data),
  });

  const complete = useMutation({
    mutationFn: async () => (await api.post(`/challenges/${id}/attempts/${attempt!.attemptId}/complete`)).data as ChallengeResult,
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ['student-challenges'] });
      if (data.gamification?.awarded) qc.invalidateQueries({ queryKey: GAMIFICATION_KEY });
    },
  });

  const retryMistakes = useMutation({
    mutationFn: async () => (await api.post(`/challenges/${id}/attempts/${result!.attemptId}/retry-mistakes`)).data as AttemptState,
    onSuccess: (data) => { setAttempt(data); setIndex(0); setResult(null); setFeedback(null); setSelected([]); },
  });

  const question = attempt?.questions[index];
  const finished = !!attempt && index >= attempt.totalQuestions;
  const answered = !!feedback;

  /** Tapping an answer *is* submitting it — no separate confirm step, so a
   *  student who knows the answer moves at their own speed instead of the
   *  UI's. One tap decides it; the same tap is disabled again immediately. */
  const pick = (optionId: string) => {
    if (!question || answered || answer.isPending) return;
    setSelected([optionId]);
    answer.mutate({ questionId: question.id, optionIds: [optionId] });
  };

  const goNext = () => {
    setFeedback(null);
    setSelected([]);
    setIndex((i) => i + 1);
  };

  // Auto-advance shortly after an answer lands — fast for Ranked (minimal
  // interruption), a beat longer for Practice (time to read the explanation)
  // — but never a forced wait: the "skip" affordance below moves on the
  // instant a student is done reading, for either mode.
  useEffect(() => {
    if (!feedback || !attempt) return;
    const delay = detail?.type === 'RANKED' ? 1100 : 2200;
    const timer = setTimeout(goNext, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedback, attempt, detail?.type]);

  useEffect(() => {
    if (finished && !result && !complete.isPending) complete.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  // Whole-attempt countdown (server deadline, client clock corrected for skew).
  const deadline = attempt?.deadlineAt ? new Date(attempt.deadlineAt).getTime() : null;
  const skew = attempt?.serverNow ? Date.now() - new Date(attempt.serverNow).getTime() : 0;
  const [msLeft, setMsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (deadline == null || finished || result) return;
    const tick = () => setMsLeft(Math.max(0, deadline + skew - Date.now()));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [deadline, skew, finished, result]);
  useEffect(() => {
    if (msLeft === 0 && !finished && !result && !complete.isPending) complete.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msLeft]);

  // Per-question countdown — cosmetic only; the server times the real thing.
  // Ticks often enough (10/s) that the live XP number below reads as a
  // smooth drain rather than a jumpy once-a-second update.
  const [qMsLeft, setQMsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!question?.timeLimitSec || feedback) { setQMsLeft(null); return; }
    const startedAt = Date.now();
    const totalMs = question.timeLimitSec * 1000;
    const tick = () => setQMsLeft(Math.max(0, totalMs - (Date.now() - startedAt)));
    tick();
    const h = setInterval(tick, 100);
    return () => clearInterval(h);
  }, [question?.id, question?.timeLimitSec, feedback]);
  useEffect(() => {
    if (qMsLeft === 0 && question && !feedback && !answer.isPending) answer.mutate({ questionId: question.id, optionIds: selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qMsLeft]);

  /**
   * "If you answer right now, here's what it's worth" — a live number tied
   * directly to the countdown bar, linear from the question's full value down
   * to 0 across its time budget (worth/total_seconds lost per second). Purely
   * a cosmetic anticipation cue, same idea as Kahoot's ticking points: the
   * server's own formula is tiered, not linear, and never actually pays 0 for
   * an in-time correct answer — this is what creates the urgency, not what
   * settles the score.
   */
  const liveXp =
    question && question.timeLimitSec && qMsLeft != null
      ? Math.round(question.points * (qMsLeft / (question.timeLimitSec * 1000)))
      : null;

  const openLeaderboard = () => {
    setShowLeaderboard(true);
    if (!leaderboard) api.get(`/challenges/${id}/leaderboard`).then(({ data }) => setLeaderboard(data));
  };

  if (loadingDetail) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (!detail) return null;

  // ── Result screen ──────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="mx-auto max-w-xl px-6 py-8 sm:px-8">
        <m.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: EASE }}
          className="card mb-6 text-center">
          {result.accuracyPct === 100 && (
            <m.p initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.4, ease: [0.2, 1.3, 0.4, 1] }}
              className="mb-2 font-heading text-lg font-extrabold text-student-gold-ink">
              {t('challenges.result.perfectScore')}
            </m.p>
          )}
          {result.status === 'TIMED_OUT' && (
            <p className="mb-2 text-sm text-error">{t('challenges.result.timedOut')}</p>
          )}
          <m.p initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.5, delay: 0.1, ease: [0.2, 1.3, 0.4, 1] }}
            className="font-heading text-5xl font-extrabold text-primary">
            {result.score}
          </m.p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('challenges.result.correctOf', { correct: result.correctCount, total: result.correctCount + result.wrongCount })}</p>

          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-outline-variant/50 pt-4 text-center">
            {[
              { value: `${result.accuracyPct}%`, label: t('challenges.result.accuracy') },
              { value: result.speedPct != null ? `${result.speedPct}%` : '—', label: t('challenges.result.speed') },
              ...(result.rank != null ? [{ value: `#${result.rank}`, label: t('challenges.result.rank') }] : []),
            ].map((s, i) => (
              <m.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 + i * 0.08 }}>
                <p className="font-heading text-xl font-extrabold">{s.value}</p>
                <p className="text-xs text-outline">{s.label}</p>
              </m.div>
            ))}
          </div>
        </m.div>

        {result.gamification?.awarded && (
          <div className="mb-6"><RewardSummary outcome={result.gamification} /></div>
        )}

        {detail.leaderboardEnabled && (
          <button className="btn-ghost mb-6 w-full" onClick={openLeaderboard}>
            {t('challenges.result.viewLeaderboard')}
          </button>
        )}
        {showLeaderboard && (
          <div className="card mb-6">
            <h3 className="mb-3 font-heading font-bold">{t('challenges.leaderboard.title')}</h3>
            {!leaderboard ? (
              <div className="skeleton h-24 rounded-xl" />
            ) : !leaderboard.length ? (
              <p className="py-4 text-center text-sm text-on-surface-variant">{t('challenges.leaderboard.empty')}</p>
            ) : (
              <div className="space-y-1.5">
                {leaderboard.map((r) => (
                  <div key={r.studentId} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${r.isMe ? 'border border-primary bg-primary-fixed/50' : 'bg-surface-container-low'}`}>
                    <span className="w-6 text-center font-bold text-outline">{r.rank}</span>
                    <span className="flex-1 truncate font-semibold">{r.name}{r.isMe && <span className="text-primary"> · {t('challenges.leaderboard.you')}</span>}</span>
                    <span className="font-bold text-student-gold-ink">{r.score}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h3 className="mb-3 font-heading font-bold">{t('challenges.result.mistakesTitle')}</h3>
          {!result.mistakes.length ? (
            <p className="py-4 text-center text-sm text-on-surface-variant">{t('challenges.result.noMistakes')}</p>
          ) : (
            <>
              <div className="space-y-3">
                {result.mistakes.map((m) => (
                  <div key={m.questionId} className="rounded-xl border border-error/15 bg-error-container/20 p-3 text-sm" dir="auto">
                    <p className="font-semibold">{m.prompt}</p>
                    {m.explanation && <p className="mt-1 text-xs text-on-surface-variant">{m.explanation}</p>}
                  </div>
                ))}
              </div>
              <button className="btn-primary mt-4 w-full" disabled={retryMistakes.isPending} onClick={() => retryMistakes.mutate()}>
                {t('challenges.result.retryMistakes')}
              </button>
              <ErrorNote error={retryMistakes.error} />
            </>
          )}
        </div>

        <Link to="/challenges" className="btn-ghost mt-6 block w-full text-center">{t('challenges.result.backToChallenges')}</Link>
      </div>
    );
  }

  // ── Finishing (auto-completing) ──────────────────────────────────────────
  if (finished) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="text-center">
          <Spinner />
          <p className="mt-2 text-sm text-on-surface-variant">{t('challenges.play.finishing')}</p>
        </div>
      </div>
    );
  }

  // ── Intro (not started yet) ───────────────────────────────────────────────
  if (!attempt) {
    return (
      <div className="mx-auto max-w-md px-6 py-8 sm:px-8">
        <Link to="/challenges" className="mb-4 inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>{t('challenges.result.backToChallenges')}
        </Link>
        <div className="card text-center">
          <span className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-3xl">{detail.coverIcon}</span>
          </span>
          <h1 className="font-heading text-2xl font-extrabold">{detail.title}</h1>
          {detail.description && <p className="mt-2 text-sm text-on-surface-variant">{detail.description}</p>}
          <div className="mt-4 flex justify-center">
            <Badge tone={detail.type === 'RANKED' ? 'primary' : 'neutral'}>
              {t(detail.type === 'RANKED' ? 'challenges.card.ranked' : 'challenges.card.practice')}
            </Badge>
          </div>
          <p className="mt-4 text-sm text-on-surface-variant">
            {t('challenges.detail.attempts', { used: detail.attemptsUsed, max: detail.maxAttempts === 0 ? t('challenges.detail.unlimitedMax') : detail.maxAttempts })}
          </p>
          <ErrorNote error={start.error} />
          <button
            className="btn-primary mt-5 w-full"
            disabled={start.isPending || (detail.attemptsRemaining != null && detail.attemptsRemaining <= 0)}
            onClick={() => start.mutate()}
          >
            {start.isPending ? t('challenges.play.loading') : t('challenges.detail.start')}
          </button>
        </div>
      </div>
    );
  }

  // ── Playing ────────────────────────────────────────────────────────────
  if (!question) return null;

  return (
    <div className="mx-auto max-w-xl px-6 py-8 sm:px-8">
      <div className="mb-4 flex items-center justify-between text-sm text-on-surface-variant">
        <span>{t('challenges.play.question', { n: index + 1, total: attempt.totalQuestions })}</span>
        {msLeft != null && (
          <span className={`flex items-center gap-1 font-bold tabular-nums ${msLeft <= 30_000 ? 'text-error' : ''}`}>
            <span className="material-symbols-outlined text-[16px]">timer</span>{clock(msLeft)}
          </span>
        )}
      </div>
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
        <m.div className="h-full rounded-full bg-primary" animate={{ width: `${((index + (answered ? 1 : 0)) / attempt.totalQuestions) * 100}%` }} transition={{ duration: 0.35, ease: EASE }} />
      </div>

      {/* The live "worth N XP right now" ticker, tied 1:1 to the per-question
          timer bar below it — the whole point is that watching the bar
          drain and watching the number drop is the same motion. */}
      {liveXp != null && !answered && (
        <div className="mb-4 text-center">
          <m.p
            key={Math.ceil(liveXp / 20)} // re-triggers the pop only every ~20 XP, not every 100ms tick
            initial={{ scale: 1.08 }} animate={{ scale: 1 }} transition={{ duration: 0.15 }}
            className={`font-heading text-3xl font-extrabold tabular-nums ${qMsLeft != null && qMsLeft <= 3000 ? 'text-error' : 'text-student-gold-ink'}`}
          >
            {liveXp} <span className="text-base font-bold">{t('gamification.xp')}</span>
          </m.p>
          <div className="mx-auto mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
            <div
              className={`h-full rounded-full ${qMsLeft != null && qMsLeft <= 3000 ? 'animate-pulse bg-error' : 'bg-student-secondary'}`}
              style={{ width: `${(qMsLeft! / (question.timeLimitSec! * 1000)) * 100}%`, transition: 'width 100ms linear' }}
            />
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        <m.div
          key={question.id}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="card"
        >
          <p className="mb-5 text-center font-heading text-xl font-extrabold" dir="auto">{question.prompt}</p>
          <div className="space-y-3">
            {question.options.map((o) => {
              const chosen = selected.includes(o.id);
              const isCorrectOpt = answered && feedback?.correctOptionIds?.includes(o.id);
              const isWrongChosen = answered && chosen && feedback && !feedback.isCorrect;
              return (
                <m.button
                  key={o.id}
                  type="button"
                  disabled={answered}
                  onClick={() => pick(o.id)}
                  whileTap={answered ? undefined : { scale: 0.97 }}
                  className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-start text-base font-semibold transition-colors ${
                    isCorrectOpt ? 'border-secondary bg-secondary-container/40'
                    : isWrongChosen ? 'border-error bg-error-container/30'
                    : chosen ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60 hover:border-primary/40'
                  }`}
                >
                  <span dir="auto" className="flex-1">{o.text}</span>
                  {isCorrectOpt && (
                    <m.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.25, ease: [0.2, 1.3, 0.4, 1] }}
                      className="material-symbols-outlined text-secondary">check_circle</m.span>
                  )}
                  {isWrongChosen && (
                    <m.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.25, ease: [0.2, 1.3, 0.4, 1] }}
                      className="material-symbols-outlined text-error">cancel</m.span>
                  )}
                </m.button>
              );
            })}
          </div>

          <AnimatePresence>
            {answered && feedback && (
              <m.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.2, 1.3, 0.4, 1] }}
                className={`mt-4 rounded-xl p-3 text-center text-sm font-bold ${feedback.isCorrect ? 'bg-secondary-container/40 text-on-secondary-container' : 'bg-error-container/40 text-on-error-container'}`}
              >
                {feedback.isCorrect ? t('challenges.play.correct') : t('challenges.play.wrong')}
                {feedback.xpAwarded > 0 && (
                  <span className="s-rise ms-2 inline-block text-student-gold-ink">+{feedback.xpAwarded} {t('gamification.xp')}</span>
                )}
                {feedback.explanation && <p className="mt-1 text-xs font-normal text-on-surface-variant" dir="auto">{feedback.explanation}</p>}
                <button type="button" onClick={goNext} className="mt-2 block w-full text-xs font-bold text-primary hover:underline">
                  {t('challenges.play.next')} ⏭
                </button>
              </m.div>
            )}
          </AnimatePresence>

          <ErrorNote error={answer.error} />
        </m.div>
      </AnimatePresence>
    </div>
  );
}

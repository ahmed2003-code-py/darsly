import { useMutation, useQueryClient } from '@tanstack/react-query';
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

  const answer = useMutation({
    mutationFn: async (questionId: string) =>
      (await api.post(`/challenges/${id}/attempts/${attempt!.attemptId}/answers`, { questionId, selectedOptionIds: selected }))
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

  // Advance to the next question, or finish once every one has an answer.
  useEffect(() => {
    if (!feedback || !attempt) return;
    const next = index + 1;
    const auto = detail?.type === 'RANKED';
    const timer = setTimeout(
      () => { setFeedback(null); setSelected([]); setIndex(next); },
      auto ? 900 : 60_000, // practice waits for the student to press Next instead
    );
    return () => clearTimeout(timer);
  }, [feedback, index, attempt, detail?.type]);

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
  const [qMsLeft, setQMsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!question?.timeLimitSec || feedback) { setQMsLeft(null); return; }
    const startedAt = Date.now();
    const totalMs = question.timeLimitSec * 1000;
    const tick = () => setQMsLeft(Math.max(0, totalMs - (Date.now() - startedAt)));
    tick();
    const h = setInterval(tick, 250);
    return () => clearInterval(h);
  }, [question?.id, question?.timeLimitSec, feedback]);
  useEffect(() => {
    if (qMsLeft === 0 && question && !feedback && !answer.isPending) answer.mutate(question.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qMsLeft]);

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
        <div className="card mb-6 text-center">
          {result.accuracyPct === 100 && (
            <p className="s-pop-in mb-2 font-heading text-lg font-extrabold text-student-gold-ink">
              {t('challenges.result.perfectScore')}
            </p>
          )}
          {result.status === 'TIMED_OUT' && (
            <p className="mb-2 text-sm text-error">{t('challenges.result.timedOut')}</p>
          )}
          <p className="s-rise font-heading text-5xl font-extrabold text-primary">{result.score}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('challenges.result.correctOf', { correct: result.correctCount, total: result.correctCount + result.wrongCount })}</p>

          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-outline-variant/50 pt-4 text-center">
            <div>
              <p className="font-heading text-xl font-extrabold">{result.accuracyPct}%</p>
              <p className="text-xs text-outline">{t('challenges.result.accuracy')}</p>
            </div>
            <div>
              <p className="font-heading text-xl font-extrabold">{result.speedPct != null ? `${result.speedPct}%` : '—'}</p>
              <p className="text-xs text-outline">{t('challenges.result.speed')}</p>
            </div>
            {result.rank != null && (
              <div>
                <p className="font-heading text-xl font-extrabold">#{result.rank}</p>
                <p className="text-xs text-outline">{t('challenges.result.rank')}</p>
              </div>
            )}
          </div>
        </div>

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
  const answered = !!feedback;

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
      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-premium" style={{ width: `${((index + (answered ? 1 : 0)) / attempt.totalQuestions) * 100}%` }} />
      </div>

      {qMsLeft != null && !answered && (
        <div className="mb-4 flex items-center justify-center gap-2">
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
            <div
              className={`h-full rounded-full transition-[width] duration-200 linear ${qMsLeft <= 3000 ? 'bg-error' : 'bg-student-secondary'}`}
              style={{ width: `${(qMsLeft / (question.timeLimitSec! * 1000)) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="card">
        <p className="mb-5 text-center font-heading text-xl font-extrabold" dir="auto">{question.prompt}</p>
        <div className="space-y-3">
          {question.options.map((o) => {
            const chosen = selected.includes(o.id);
            const isCorrectOpt = answered && feedback?.correctOptionIds?.includes(o.id);
            const isWrongChosen = answered && chosen && feedback && !feedback.isCorrect;
            return (
              <button
                key={o.id}
                type="button"
                disabled={answered}
                onClick={() => setSelected([o.id])}
                className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-start text-base font-semibold transition ${
                  isCorrectOpt ? 'border-secondary bg-secondary-container/40'
                  : isWrongChosen ? 'border-error bg-error-container/30'
                  : chosen ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60 hover:border-primary/40'
                }`}
              >
                <span dir="auto" className="flex-1">{o.text}</span>
                {isCorrectOpt && <span className="material-symbols-outlined text-secondary">check_circle</span>}
                {isWrongChosen && <span className="material-symbols-outlined text-error">cancel</span>}
              </button>
            );
          })}
        </div>

        {answered && feedback && (
          <div className={`s-pop-in mt-4 rounded-xl p-3 text-center text-sm font-bold ${feedback.isCorrect ? 'bg-secondary-container/40 text-on-secondary-container' : 'bg-error-container/40 text-on-error-container'}`}>
            {feedback.isCorrect ? t('challenges.play.correct') : t('challenges.play.wrong')}
            {feedback.xpAwarded > 0 && <span className="ms-2 text-student-gold-ink">+{feedback.xpAwarded} XP</span>}
            {feedback.explanation && <p className="mt-1 text-xs font-normal text-on-surface-variant" dir="auto">{feedback.explanation}</p>}
          </div>
        )}

        <ErrorNote error={answer.error} />
        {!answered ? (
          <button className="btn-primary mt-5 w-full" disabled={!selected.length || answer.isPending} onClick={() => answer.mutate(question.id)}>
            {t('challenges.play.submit')}
          </button>
        ) : detail.type !== 'RANKED' ? (
          <button className="btn-primary mt-5 w-full" onClick={() => { setFeedback(null); setSelected([]); setIndex(index + 1); }}>
            {t('challenges.play.next')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

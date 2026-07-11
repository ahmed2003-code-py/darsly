import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, Spinner } from '../../components/ui';

export default function QuizTakerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);

  const { data: quiz, isLoading } = useQuery({
    queryKey: ['quiz', lessonId],
    queryFn: async () => (await api.get(`/lessons/${lessonId}/quiz`)).data,
  });

  const submit = useMutation({
    mutationFn: async () => (await api.post(`/lessons/${lessonId}/quiz/attempts`, { answers })).data,
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ['quiz', lessonId] });
    },
  });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (!quiz) return null;

  const reviewById: Record<string, any> = {};
  (result?.review ?? []).forEach((r: any) => (reviewById[r.id] = r));
  const done = !!result;
  const answered = Object.keys(answers).length;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
      <Link to={`/course/${courseId}`} className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base">arrow_forward</span>{t('assess.take.backCourse')}
      </Link>
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary">
          <span className="material-symbols-outlined text-2xl">quiz</span>
        </span>
        <div>
          <h1 className="font-heading text-2xl font-extrabold">{t('assess.take.quizTitle')}</h1>
          <p className="text-sm text-outline">{t('assess.take.passNeeded', { pct: quiz.passingScore })}</p>
        </div>
      </div>

      {/* Result banner */}
      {done && (
        <div className={`card mb-6 text-center ${result.passed ? 'border-secondary' : result.needsManualGrading ? 'border-warn' : 'border-error'} border-2`}>
          {result.needsManualGrading ? (
            <>
              <span className="material-symbols-outlined mb-1 text-4xl text-warn">hourglass_top</span>
              <p className="font-heading text-lg font-bold">{t('assess.take.pendingManual')}</p>
              <p className="text-sm text-outline">{t('assess.take.pendingManualHint')}</p>
            </>
          ) : (
            <>
              <p className={`font-heading text-4xl font-extrabold ${result.passed ? 'text-secondary' : 'text-error'}`}>{result.scorePct}%</p>
              <p className="mt-1 font-bold">{result.passed ? t('assess.take.passed') : t('assess.take.failed')}</p>
            </>
          )}
        </div>
      )}

      {/* Prior attempt (before submitting again) */}
      {!done && quiz.lastAttempt && (
        <div className="card mb-6 flex items-center justify-between">
          <span className="text-sm text-on-surface-variant">{t('assess.take.lastAttempt')}</span>
          {quiz.lastAttempt.needsManualGrading
            ? <Badge tone="warn">{t('assess.q.needsGrading')}</Badge>
            : <Badge tone={quiz.lastAttempt.passed ? 'teal' : 'error'}>{quiz.lastAttempt.scorePct}%</Badge>}
        </div>
      )}

      <div className="space-y-4">
        {quiz.questions.map((q: any, i: number) => {
          const rev = reviewById[q.id];
          return (
            <div key={q.id} className="card">
              <p className="mb-3 font-bold" dir="auto">
                <span className="me-1 text-primary">{i + 1}.</span>{q.prompt}
                <span className="ms-2 text-xs font-normal text-outline">({t('assess.q.pointsN', { n: q.points })})</span>
              </p>

              {q.type === 'SHORT_ANSWER' ? (
                <textarea className="input min-h-[4rem]" dir="auto" disabled={done}
                  value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  placeholder={t('assess.take.yourAnswer')} />
              ) : (
                <div className="space-y-2">
                  {q.options.map((o: any) => {
                    const chosen = answers[q.id] === o.id;
                    const isCorrect = done && rev && rev.correctOptionId === o.id;
                    const isWrongChosen = done && chosen && rev && !rev.correct;
                    return (
                      <label key={o.id}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                          isCorrect ? 'border-secondary bg-secondary-container/40'
                          : isWrongChosen ? 'border-error bg-error-container/30'
                          : chosen ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50'}`}>
                        <input type="radio" className="accent-primary" name={q.id} disabled={done} checked={chosen}
                          onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))} />
                        <span dir="auto">{o.text}</span>
                        {isCorrect && <span className="material-symbols-outlined ms-auto text-base text-secondary">check_circle</span>}
                      </label>
                    );
                  })}
                </div>
              )}

              {done && rev?.explanation && (
                <p className="mt-2 rounded-lg bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant" dir="auto">
                  <span className="font-bold">{t('assess.take.explanation')}: </span>{rev.explanation}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <ErrorNote error={submit.error} />
      {!done ? (
        <button className="btn-primary mt-6 w-full" disabled={submit.isPending || answered < quiz.questions.length}
          onClick={() => submit.mutate()}>
          {submit.isPending ? t('common.saving') : t('assess.take.submit')}
        </button>
      ) : (
        <Link to={`/course/${courseId}`} className="btn-primary mt-6 block w-full text-center">{t('assess.take.backCourse')}</Link>
      )}
    </div>
  );
}

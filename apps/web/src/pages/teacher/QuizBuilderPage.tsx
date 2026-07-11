import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, PageHeader, Spinner } from '../../components/ui';

type Opt = { id: string; text: string };
type Q = {
  type: 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  prompt: string;
  options: Opt[];
  correctOptionId: string | null;
  explanation: string;
  points: number;
};

const rid = () => Math.random().toString(36).slice(2, 8);
const blankQ = (type: Q['type']): Q => {
  if (type === 'TRUE_FALSE') {
    return { type, prompt: '', options: [{ id: 'true', text: 'صح' }, { id: 'false', text: 'خطأ' }], correctOptionId: 'true', explanation: '', points: 1 };
  }
  if (type === 'SHORT_ANSWER') {
    return { type, prompt: '', options: [], correctOptionId: null, explanation: '', points: 1 };
  }
  const a = rid(), b = rid();
  return { type: 'MCQ', prompt: '', options: [{ id: a, text: '' }, { id: b, text: '' }], correctOptionId: a, explanation: '', points: 1 };
};

export default function QuizBuilderPage() {
  const { t } = useTranslation();
  const { lessonId } = useParams();
  const qc = useQueryClient();

  const [passingScore, setPassingScore] = useState(50);
  const [questions, setQuestions] = useState<Q[]>([]);
  const [gradingId, setGradingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['tquiz', lessonId],
    queryFn: async () => (await api.get(`/teacher/lessons/${lessonId}/quiz`)).data,
  });

  useEffect(() => {
    if (data) {
      setPassingScore(data.passingScore ?? 50);
      setQuestions(
        (data.questions ?? []).map((q: any) => ({
          type: q.type, prompt: q.prompt, options: q.options ?? [],
          correctOptionId: q.correctOptionId, explanation: q.explanation ?? '', points: q.points ?? 1,
        })),
      );
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      await api.put(`/teacher/lessons/${lessonId}/quiz`, { passingScore });
      return (await api.put(`/teacher/lessons/${lessonId}/quiz/questions`, { questions })).data;
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
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <Link to="/teacher/courses" className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base">arrow_forward</span>{t('assess.builder.backCourses')}
      </Link>
      <PageHeader title={t('assess.builder.quizTitle')} subtitle={t('assess.builder.quizSubtitle')} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* Editor */}
        <div className="space-y-4">
          {questions.map((q, i) => (
            <div key={i} className="card">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-fixed text-sm font-bold text-primary">{i + 1}</span>
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
                  {q.options.map((o) => (
                    <label key={o.id} className="flex items-center gap-2">
                      <input type="radio" className="accent-primary" checked={q.correctOptionId === o.id}
                        onChange={() => setQ(i, { correctOptionId: o.id })} />
                      <input className="input py-1.5 text-sm" dir="auto" value={o.text} disabled={q.type === 'TRUE_FALSE'}
                        placeholder={t('assess.q.optionPlaceholder')}
                        onChange={(e) => setQ(i, { options: q.options.map((oo) => (oo.id === o.id ? { ...oo, text: e.target.value } : oo)) })} />
                      {q.type === 'MCQ' && q.options.length > 2 && (
                        <button className="text-outline hover:text-error"
                          onClick={() => setQ(i, { options: q.options.filter((oo) => oo.id !== o.id) })}>
                          <span className="material-symbols-outlined text-base">close</span>
                        </button>
                      )}
                    </label>
                  ))}
                  {q.type === 'MCQ' && (
                    <button className="text-sm text-primary hover:underline"
                      onClick={() => setQ(i, { options: [...q.options, { id: rid(), text: '' }] })}>
                      + {t('assess.q.addOption')}
                    </button>
                  )}
                  <p className="text-xs text-outline">{t('assess.q.pickCorrect')}</p>
                </div>
              ) : (
                <p className="rounded-lg bg-surface-container-low px-3 py-2 text-xs text-outline">{t('assess.q.manualNote')}</p>
              )}

              <div className="mt-3 flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  {t('assess.q.points')}
                  <input className="input w-16 py-1 text-sm" inputMode="numeric" value={q.points}
                    onChange={(e) => setQ(i, { points: Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1) })} />
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
            <button className="btn-primary mt-4 w-full" disabled={save.isPending || !questions.length} onClick={() => save.mutate()}>
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

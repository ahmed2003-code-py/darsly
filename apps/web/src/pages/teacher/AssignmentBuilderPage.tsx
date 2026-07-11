import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, Field, PageHeader, Spinner } from '../../components/ui';

export default function AssignmentBuilderPage() {
  const { t } = useTranslation();
  const { lessonId } = useParams();
  const qc = useQueryClient();

  const [prompt, setPrompt] = useState('');
  const [maxScore, setMaxScore] = useState(100);
  const [dueAt, setDueAt] = useState('');
  const [grading, setGrading] = useState<Record<string, { score: string; feedback: string }>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['tassign', lessonId],
    queryFn: async () => (await api.get(`/teacher/lessons/${lessonId}/assignment`)).data,
  });

  useEffect(() => {
    if (data) {
      setPrompt(data.prompt ?? '');
      setMaxScore(data.maxScore ?? 100);
      setDueAt(data.dueAt ? String(data.dueAt).slice(0, 10) : '');
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      (await api.put(`/teacher/lessons/${lessonId}/assignment`, {
        prompt, maxScore, dueAt: dueAt || null,
      })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tassign', lessonId] }),
  });

  const grade = useMutation({
    mutationFn: async ({ id, score, feedback }: { id: string; score: number; feedback: string }) =>
      (await api.post(`/teacher/assignment-submissions/${id}/grade`, { score, feedback })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tassign', lessonId] }),
  });

  if (isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <Link to="/teacher/courses" className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base">arrow_forward</span>{t('assess.builder.backCourses')}
      </Link>
      <PageHeader title={t('assess.builder.assignTitle')} subtitle={t('assess.builder.assignSubtitle')} />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <Field label={t('assess.assign.prompt')}>
            <textarea className="input min-h-[8rem]" dir="auto" value={prompt}
              onChange={(e) => setPrompt(e.target.value)} placeholder={t('assess.assign.promptPlaceholder')} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('assess.assign.maxScore')}>
              <input className="input" inputMode="numeric" value={maxScore}
                onChange={(e) => setMaxScore(Math.max(1, Number(e.target.value.replace(/\D/g, '')) || 1))} />
            </Field>
            <Field label={t('assess.assign.dueAt')}>
              <input className="input" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </Field>
          </div>
          <button className="btn-primary mt-2 w-full" disabled={save.isPending || !prompt.trim()} onClick={() => save.mutate()}>
            {save.isPending ? t('common.saving') : t('assess.assign.save')}
          </button>
          {save.isSuccess && <p className="mt-2 text-center text-sm text-secondary">{t('common.saved')}</p>}
          <ErrorNote error={save.error} />
        </div>

        <div className="card">
          <h3 className="mb-3 font-heading font-bold">{t('assess.assign.submissions')}</h3>
          {!data?.submissions?.length ? (
            <p className="py-6 text-center text-sm text-outline">{t('assess.assign.noSubmissions')}</p>
          ) : (
            <ul className="space-y-3">
              {data.submissions.map((s: any) => {
                const g = grading[s.id] ?? { score: s.score != null ? String(s.score) : '', feedback: s.feedback ?? '' };
                return (
                  <li key={s.id} className="rounded-xl border border-outline-variant/40 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-bold">{s.student?.user?.fullName}</span>
                      {s.gradedAt ? <Badge tone="neutral">{s.score}/{data.maxScore}</Badge> : <Badge tone="warn">{t('assess.assign.ungraded')}</Badge>}
                    </div>
                    {s.body && <p className="mb-2 whitespace-pre-wrap rounded bg-surface-container-low px-3 py-2 text-sm" dir="auto">{s.body}</p>}
                    <div className="flex items-end gap-2">
                      <label className="text-xs">
                        {t('assess.assign.score')}
                        <input className="input w-20 py-1 text-sm" inputMode="numeric" value={g.score}
                          onChange={(e) => setGrading((x) => ({ ...x, [s.id]: { ...g, score: e.target.value.replace(/\D/g, '') } }))} />
                      </label>
                      <input className="input flex-1 py-1 text-sm" dir="auto" placeholder={t('assess.assign.feedback')} value={g.feedback}
                        onChange={(e) => setGrading((x) => ({ ...x, [s.id]: { ...g, feedback: e.target.value } }))} />
                      <button className="btn-primary px-4 py-1.5 text-sm" disabled={grade.isPending || g.score === ''}
                        onClick={() => grade.mutate({ id: s.id, score: Number(g.score), feedback: g.feedback })}>
                        {t('assess.assign.grade')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

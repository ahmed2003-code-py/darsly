import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, Spinner } from '../../components/ui';
import { dateShort } from '../../lib/format';

export default function AssignmentPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const qc = useQueryClient();
  const [body, setBody] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['assignment', lessonId],
    queryFn: async () => (await api.get(`/lessons/${lessonId}/assignment`)).data,
  });

  useEffect(() => {
    if (data?.mySubmission?.body) setBody(data.mySubmission.body);
  }, [data]);

  const submit = useMutation({
    mutationFn: async () => (await api.post(`/lessons/${lessonId}/assignment/submissions`, { body })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignment', lessonId] }),
  });

  if (isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (!data) return null;

  const { assignment, mySubmission } = data;
  const graded = mySubmission?.gradedAt;
  const locked = !!graded;

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 sm:px-8">
      <Link to={`/course/${courseId}`} className="mb-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <span className="material-symbols-outlined text-base">arrow_forward</span>{t('assess.take.backCourse')}
      </Link>
      <div className="mb-6 flex items-center gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed text-primary">
          <span className="material-symbols-outlined text-2xl">assignment</span>
        </span>
        <div>
          <h1 className="font-heading text-2xl font-extrabold">{t('assess.take.assignTitle')}</h1>
          {assignment.dueAt && <p className="text-sm text-outline">{t('assess.assign.dueAt')}: {dateShort(assignment.dueAt)}</p>}
        </div>
      </div>

      <div className="card mb-4">
        <p className="whitespace-pre-wrap" dir="auto">{assignment.prompt}</p>
        <p className="mt-2 text-xs text-outline">{t('assess.assign.maxScore')}: {assignment.maxScore}</p>
      </div>

      {graded && (
        <div className="card mb-4 border-2 border-secondary">
          <div className="flex items-center justify-between">
            <span className="font-heading font-bold">{t('assess.take.grade')}</span>
            <Badge tone="teal">{mySubmission.score}/{assignment.maxScore}</Badge>
          </div>
          {mySubmission.feedback && (
            <p className="mt-2 rounded-lg bg-surface-container-low px-3 py-2 text-sm" dir="auto">{mySubmission.feedback}</p>
          )}
        </div>
      )}

      <div className="card">
        <label className="mb-1 block text-sm font-bold">{t('assess.take.yourAnswer')}</label>
        <textarea className="input min-h-[10rem]" dir="auto" value={body} disabled={locked}
          onChange={(e) => setBody(e.target.value)} placeholder={t('assess.take.answerPlaceholder')} />
        <ErrorNote error={submit.error} />
        {!locked ? (
          <button className="btn-primary mt-3 w-full" disabled={submit.isPending || !body.trim()} onClick={() => submit.mutate()}>
            {submit.isPending ? t('common.saving') : mySubmission ? t('assess.take.resubmit') : t('assess.take.submitAssign')}
          </button>
        ) : (
          <p className="mt-3 text-center text-sm text-outline">{t('assess.take.lockedGraded')}</p>
        )}
        {submit.isSuccess && !locked && <p className="mt-2 text-center text-sm text-secondary">{t('assess.take.submitted')}</p>}
      </div>
    </div>
  );
}

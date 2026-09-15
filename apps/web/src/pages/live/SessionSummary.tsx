import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Spinner } from '../../components/ui';

/**
 * What the lesson came to, after it happened.
 *
 * The same component serves both sides of the class, because the server has
 * already decided what each of them may read: a student whose teacher has not
 * shared the summary is simply told there is nothing yet, rather than being
 * shown a locked door they can rattle.
 */

interface Summary {
  summary: string;
  topics: string[];
  keyPoints: string[];
  questionsAndAnswers: { question: string; answer: string }[];
  actionItems: string[];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="mb-1.5 font-heading text-sm font-extrabold text-primary">{title}</h4>
      {children}
    </div>
  );
}

function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-outline">{empty}</p>;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-sm" dir="auto">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SessionSummary({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['live-detail', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/detail`)).data,
    // While the job runs, the page catches up on its own rather than asking the
    // teacher to refresh a thing they cannot influence.
    refetchInterval: (q) => (q.state.data?.summary?.status === 'PROCESSING' ? 5000 : false),
  });

  const generate = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${sessionId}/summary`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });
  const share = useMutation({
    mutationFn: async (visible: boolean) =>
      (await api.patch(`/teacher/live/${sessionId}/summary/visibility`, { visible })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-detail', sessionId] }),
  });

  if (detail.isLoading) return <div className="py-6 text-center"><Spinner /></div>;
  if (detail.isError) return null;

  const d = detail.data;
  const isTeacher = d.role === 'TEACHER';
  const status: string = d.summary.status;
  const data: Summary | null = d.summary.data;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-heading text-base font-bold">{t('summary.title')}</h3>
        {isTeacher && status === 'READY' && (
          <label className="flex items-center gap-2 text-xs font-bold">
            <input
              type="checkbox"
              className="accent-primary"
              checked={d.summary.sharedWithStudents}
              onChange={(e) => share.mutate(e.target.checked)}
            />
            {t('summary.share')}
          </label>
        )}
      </div>

      {status === 'PROCESSING' && (
        <p className="flex items-center gap-2 py-4 text-sm text-outline">
          <Spinner />
          {t('summary.processing')}
        </p>
      )}

      {status === 'FAILED' && (
        <div className="py-2">
          <p className="mb-2 text-sm text-outline">{t('summary.failed')}</p>
          {isTeacher && (
            <button className="btn-ghost text-sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
              {t('summary.retry')}
            </button>
          )}
        </div>
      )}

      {status === 'NOT_STARTED' &&
        (isTeacher ? (
          <div className="py-2">
            <p className="mb-2 text-sm text-outline">{t('summary.notYetHint')}</p>
            <button className="btn-primary text-sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
              <span className="material-symbols-outlined text-base">auto_awesome</span>
              {generate.isPending ? t('common.saving') : t('summary.generate')}
            </button>
          </div>
        ) : (
          <p className="py-4 text-sm text-outline">{t('summary.notShared')}</p>
        ))}

      {status === 'READY' && data && (
        <div dir="auto">
          <Section title={t('summary.lesson')}>
            <p className="text-sm leading-relaxed">{data.summary}</p>
          </Section>
          <Section title={t('summary.topics')}>
            <div className="flex flex-wrap gap-1.5">
              {data.topics.length ? (
                data.topics.map((tp, i) => (
                  <span key={i} className="rounded-full bg-primary-fixed px-2.5 py-1 text-xs font-semibold text-on-primary-fixed">
                    {tp}
                  </span>
                ))
              ) : (
                <p className="text-sm text-outline">{t('summary.noneTopics')}</p>
              )}
            </div>
          </Section>
          <Section title={t('summary.keyPoints')}>
            <Bullets items={data.keyPoints} empty={t('summary.noneKeyPoints')} />
          </Section>
          <Section title={t('summary.qa')}>
            {data.questionsAndAnswers.length ? (
              <ul className="space-y-2">
                {data.questionsAndAnswers.map((qa, i) => (
                  <li key={i} className="rounded-xl bg-surface-container-low p-2.5">
                    <p className="text-sm font-bold">{qa.question}</p>
                    <p className="mt-0.5 text-sm text-on-surface-variant">{qa.answer}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-outline">{t('summary.noneQa')}</p>
            )}
          </Section>
          <Section title={t('summary.homework')}>
            {/* Said explicitly rather than left blank: "nothing was set" is an
                answer a student needs, and an empty space is not one. */}
            <Bullets items={data.actionItems} empty={t('summary.noneHomework')} />
          </Section>
        </div>
      )}
    </div>
  );
}

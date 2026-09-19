import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort } from '../../lib/format';
import {
  useChallengeAnalytics,
  useChallengeSubmissions,
  useTeacherChallenges,
} from '../../lib/challenges';
import { Badge, CardGridSkeleton, EmptyState, ErrorNote, Modal, PageHeader } from '../../components/ui';

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'neutral' | 'error'> = {
  DRAFT: 'warn',
  PUBLISHED: 'teal',
  ACTIVE: 'teal',
  CLOSED: 'neutral',
  ARCHIVED: 'neutral',
};

const TABS = ['ALL', 'DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const;

export default function TeacherChallengesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>('ALL');
  const [resultsFor, setResultsFor] = useState<string | null>(null);

  const { data: all, isLoading } = useTeacherChallenges();
  const rows = (all ?? []).filter((c) => tab === 'ALL' || c.status === tab);

  const create = useMutation({
    mutationFn: async () => (await api.post('/teacher/challenges', { title: t('challenges.teacher.create') })).data,
    onSuccess: (row) => navigate(`/teacher/challenges/${row.id}`),
  });

  const duplicate = useMutation({
    mutationFn: async (id: string) => (await api.post(`/teacher/challenges/${id}/duplicate`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-challenges'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/teacher/challenges/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teacher-challenges'] }),
  });

  return (
    <div className="page">
      <PageHeader
        title={t('challenges.teacher.title')}
        subtitle={t('challenges.teacher.subtitle')}
        action={
          <button className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            <span className="material-symbols-outlined text-[20px] align-[-4px]">add</span>{' '}
            {t('challenges.teacher.create')}
          </button>
        }
      />
      <ErrorNote error={create.error} />

      <div className="mb-6 inline-flex gap-1 rounded-full bg-surface-container-high p-1">
        {TABS.map((s) => (
          <button
            key={s}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
              tab === s ? 'bg-surface-container-lowest text-primary shadow-hairline' : 'text-on-surface-variant'
            }`}
            onClick={() => setTab(s)}
          >
            {s === 'ALL' ? t('common.all') : t(`challenges.teacher.status.${s}`)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <CardGridSkeleton />
      ) : !rows.length ? (
        <EmptyState icon="social_leaderboard" title={t('challenges.teacher.empty')} />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <div key={c.id} className="card-hover card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
                  <span className="material-symbols-outlined">{c.coverIcon || 'bolt'}</span>
                </span>
                <Badge tone={STATUS_TONE[c.status]}>{t(`challenges.teacher.status.${c.status}`)}</Badge>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-heading text-lg font-extrabold">{c.title}</h3>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {t('challenges.teacher.questionsCount', { count: c.questionCount })} ·{' '}
                  {t('challenges.teacher.attemptsCount', { count: c.attemptCount })}
                </p>
                {c.publishedAt && (
                  <p className="mt-0.5 text-xs text-outline">{dateShort(c.publishedAt)}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 border-t border-outline-variant/50 pt-3">
                <button className="btn-ghost text-sm" onClick={() => navigate(`/teacher/challenges/${c.id}`)}>
                  {t('challenges.teacher.edit')}
                </button>
                <button className="btn-ghost text-sm" onClick={() => setResultsFor(c.id)}>
                  {t('challenges.teacher.viewSubmissions')}
                </button>
                <button className="btn-ghost text-sm" onClick={() => duplicate.mutate(c.id)}>
                  {t('challenges.teacher.duplicate')}
                </button>
                <button
                  className="btn-ghost text-sm text-error/80 hover:text-error"
                  onClick={() => remove.mutate(c.id)}
                >
                  {c.attemptCount > 0 ? t('challenges.teacher.archive') : t('challenges.teacher.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ResultsModal id={resultsFor} onClose={() => setResultsFor(null)} />
    </div>
  );
}

function ResultsModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: submissions, isLoading: loadingSubs } = useChallengeSubmissions(id ?? undefined);
  const { data: stats, isLoading: loadingStats } = useChallengeAnalytics(id ?? undefined);

  return (
    <Modal open={!!id} title={t('challenges.teacher.viewSubmissions')} onClose={onClose} wide>
      {loadingStats ? (
        <div className="skeleton h-24 rounded-xl" />
      ) : stats ? (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('challenges.teacher.analytics.participants')} value={stats.participants} />
          <Stat label={t('challenges.teacher.analytics.completionRate')} value={`${stats.completionRatePct}%`} />
          <Stat label={t('challenges.teacher.analytics.avgScore')} value={stats.avgScore} />
          <Stat label={t('challenges.teacher.analytics.avgAccuracy')} value={`${stats.avgAccuracyPct}%`} />
        </div>
      ) : null}

      {loadingSubs ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-12 rounded-xl" />
          ))}
        </div>
      ) : !submissions?.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">{t('challenges.teacher.submissions.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-xs font-bold uppercase text-outline">
                <th className="py-2 pe-3 text-start">{t('challenges.teacher.submissions.student')}</th>
                <th className="py-2 pe-3 text-start">{t('challenges.teacher.submissions.score')}</th>
                <th className="py-2 pe-3 text-start">{t('challenges.teacher.submissions.accuracy')}</th>
                <th className="py-2 pe-3 text-start">{t('challenges.teacher.submissions.xp')}</th>
                <th className="py-2 text-start">{t('challenges.teacher.submissions.completedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s: any) => (
                <tr key={s.id} className="border-t border-outline-variant/40">
                  <td className="py-2 pe-3 font-semibold">{s.studentName}</td>
                  <td className="py-2 pe-3">{s.score}</td>
                  <td className="py-2 pe-3">{s.accuracyPct}%</td>
                  <td className="py-2 pe-3 font-bold text-student-gold-ink">+{s.xpAwarded}</td>
                  <td className="py-2 text-outline">{dateShort(s.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-surface-container-low p-3 text-center">
      <div className="font-heading text-xl font-extrabold">{value}</div>
      <div className="text-xs text-on-surface-variant">{label}</div>
    </div>
  );
}

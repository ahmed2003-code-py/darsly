import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useGamification } from '../../lib/gamification';
import { useStudentChallenges } from '../../lib/challenges';
import { LevelCard } from '../../components/gamification/LevelCard';
import { Badge, CardGridSkeleton, EmptyState, PageHeader } from '../../components/ui';

const TABS = ['available', 'in_progress', 'completed'] as const;

export default function ChallengesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof TABS)[number]>('available');

  const { data: g } = useGamification();
  const { data: cards, isLoading } = useStudentChallenges(tab);

  return (
    <div className="page">
      <PageHeader title={t('challenges.title')} subtitle={t('challenges.subtitle')} />

      {g && (
        <div className="mb-6">
          <LevelCard g={g} compact />
        </div>
      )}

      <div className="mb-6 inline-flex gap-1 rounded-full bg-surface-container-high p-1">
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
              tab === tb
                ? 'bg-surface-container-lowest text-primary shadow-hairline'
                : 'text-on-surface-variant'
            }`}
          >
            {t(`challenges.tabs.${tb}`)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <CardGridSkeleton />
      ) : !cards?.length ? (
        <EmptyState icon="social_leaderboard" title={t(`challenges.empty.${tab}`)} />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <div key={c.id} className="card-hover card flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
                  <span className="material-symbols-outlined text-[22px]">
                    {c.coverIcon || 'bolt'}
                  </span>
                </span>
                <Badge tone={c.type === 'RANKED' ? 'primary' : 'neutral'}>
                  {t(c.type === 'RANKED' ? 'challenges.card.ranked' : 'challenges.card.practice')}
                </Badge>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-heading text-lg font-extrabold">{c.title}</h3>
                <p className="mt-1 text-sm text-on-surface-variant">{c.teacherName}</p>
                <p className="mt-1 text-xs text-outline">
                  {t('challenges.card.questions', { count: c.questionCount })}
                </p>
              </div>

              {c.bestScore != null && (
                <p className="text-sm font-bold text-student-gold-ink">
                  {t('challenges.card.bestScore', { score: c.bestScore })}
                </p>
              )}
              <p className="text-xs text-outline">
                {c.attemptsRemaining == null
                  ? t('challenges.card.unlimitedAttempts')
                  : c.attemptsRemaining > 0
                    ? t('challenges.card.attemptsLeft', { count: c.attemptsRemaining })
                    : t('challenges.card.noAttemptsLeft')}
              </p>

              <button
                className="btn-primary mt-1 w-full"
                disabled={!c.canPlay && !c.inProgress}
                onClick={() => navigate(`/challenges/${c.id}/play`)}
              >
                {c.inProgress
                  ? t('challenges.card.resume')
                  : c.canPlay
                    ? t('challenges.card.play')
                    : t('challenges.card.review')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

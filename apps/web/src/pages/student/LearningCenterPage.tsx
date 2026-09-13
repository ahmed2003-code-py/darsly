import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import {
  AchievementRow,
  GAMIFICATION_KEY,
  compactNum,
  useGamification,
  useLocalized,
} from '../../lib/gamification';
import { AchievementGrid } from '../../components/gamification/AchievementGrid';
import { LeaderboardPanel } from '../../components/gamification/LeaderboardPanel';
import { LevelCard, StreakAtRisk } from '../../components/gamification/LevelCard';
import { MissionList } from '../../components/gamification/MissionList';
import { ErrorNote, PageHeader, Skeleton } from '../../components/ui';
import { Reveal } from '../../components/motion';
import { Link } from 'react-router-dom';

const TABS = ['overview', 'missions', 'achievements', 'leaderboard', 'rewards', 'activity'] as const;
type Tab = (typeof TABS)[number];

/**
 * The learning centre: one place that answers "where am I, and what's next?".
 *
 * Everything here already existed as a number somewhere in the product — a
 * streak on a dashboard, a badge rail, a certificate count. What it did not
 * have was a home, so none of it added up to a sense of progress.
 */
export default function LearningCenterPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const { data: g, isLoading, error } = useGamification();

  if (isLoading) {
    return (
      <div className="mx-auto max-w-container space-y-4 px-6 py-8 sm:px-8">
        <Skeleton className="h-40 rounded-3xl" />
        <Skeleton className="h-64 rounded-3xl" />
      </div>
    );
  }
  if (error || !g) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('gamification.title')} subtitle={t('gamification.subtitle')} />

      <div className="mb-6 space-y-4">
        <StreakAtRisk g={g} />
        <LevelCard g={g} compact />
        {/* Where the loop closes: the XP on this screen is what the Studio
            spends, so the way in belongs next to the number. */}
        <Link
          to="/studio"
          className="studio-card flex items-center gap-3 rounded-2xl border border-student-accent-border bg-student-accent-soft px-4 py-3 transition hover:border-student-accent"
        >
          <span className="material-symbols-outlined text-student-accent-ink">palette</span>
          <span className="min-w-0 flex-1">
            <span className="block font-heading font-bold text-student-accent-ink">
              {t('myStudio.customize')}
            </span>
            <span className="block text-sm text-on-surface-variant">{t('myStudio.subtitle')}</span>
          </span>
          <span className="material-symbols-outlined text-outline rtl:-scale-x-100">chevron_right</span>
        </Link>
      </div>

      {/* Tabs — horizontally scrollable on a phone, never wrapped into rows */}
      <div className="scroll-x mb-6 -mx-6 px-6 sm:mx-0 sm:px-0">
        <div className="inline-flex min-w-full gap-1 rounded-full bg-surface-container-high p-1">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
                tab === k ? 'bg-surface-container-lowest text-primary shadow-hairline' : 'text-on-surface-variant'
              }`}
            >
              {t(`gamification.tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview' && <Overview g={g} />}
      {tab === 'missions' && (
        <div className="space-y-6">
          <MissionList missions={g.missions} kind="DAILY" />
          <MissionList missions={g.missions} kind="WEEKLY" />
          {!g.missions.length && (
            <p className="card py-10 text-center text-sm text-on-surface-variant">
              {t('gamification.missions.empty')}
            </p>
          )}
        </div>
      )}
      {tab === 'achievements' && <AchievementsTab />}
      {tab === 'leaderboard' && <LeaderboardPanel scope="GLOBAL" />}
      {tab === 'rewards' && <RewardsTab />}
      {tab === 'activity' && <ActivityTab />}
    </div>
  );
}

function Overview({ g }: { g: ReturnType<typeof useGamification>['data'] & {} }) {
  const { t } = useTranslation();
  const L = useLocalized();
  const stats: [string, number | string][] = [
    [t('gamification.stats.lessons'), g.stats.lessonsCompleted],
    [t('gamification.stats.quizzes'), g.stats.quizzesPassed],
    [t('gamification.stats.perfect'), g.stats.perfectQuizzes],
    [t('gamification.stats.courses'), g.stats.coursesCompleted],
    [t('gamification.stats.certificates'), g.stats.certificates],
    [t('gamification.stats.assignments'), g.stats.assignmentsDone],
    [t('gamification.stats.live'), g.stats.liveAttended],
    [t('gamification.stats.accuracy'), g.stats.quizAccuracy != null ? `${g.stats.quizAccuracy}%` : '—'],
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <MissionList missions={g.missions} kind="DAILY" />
        <MissionList missions={g.missions} kind="WEEKLY" />

        <section>
          <h2 className="mb-3 font-heading text-lg font-extrabold">{t('gamification.stats.title')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(([label, value]) => (
              <div key={label} className="card text-center">
                <p className="font-heading text-2xl font-extrabold text-primary">{value}</p>
                <p className="mt-0.5 text-xs text-on-surface-variant">{label}</p>
              </div>
            ))}
          </div>
        </section>

        {g.achievements.recent.length > 0 && (
          <section>
            <h2 className="mb-3 font-heading text-lg font-extrabold">{t('gamification.achievements.title')}</h2>
            <div className="scroll-x -mx-6 flex gap-3 px-6 pb-2 sm:mx-0 sm:px-0">
              {g.achievements.recent.map((a) => (
                <div
                  key={a.key}
                  className="flex min-w-[8.5rem] flex-col items-center gap-1.5 rounded-xl border border-accent-300 bg-primary-fixed/50 p-4 text-center"
                >
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-primary text-on-primary">
                    <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
                      {a.icon}
                    </span>
                  </span>
                  <span className="text-sm font-semibold">{L({ ar: a.titleAr, en: a.titleEn })}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="space-y-6">
        <div className="card text-center">
          <span className="material-symbols-outlined text-[28px] text-student-gold-ink" style={{ fontVariationSettings: "'FILL' 1" }}>
            {g.rank.divisionIcon}
          </span>
          <p className="font-heading text-lg font-extrabold">
            {t(`gamification.leaderboard.divisions.${g.rank.division}`, g.rank.division)}
          </p>
          <p className="text-sm text-on-surface-variant">
            {t('gamification.rankShort', { n: g.rank.weekly })} · {compactNum(g.rank.weeklyXp)} {t('gamification.xp')}
          </p>
          {g.rank.best != null && (
            <p className="mt-1 text-xs text-outline">{t('gamification.bestRank', { n: g.rank.best })}</p>
          )}
        </div>
        <LeaderboardPanel scope="GLOBAL" compact />
      </aside>
    </div>
  );
}

function AchievementsTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<AchievementRow[]>({
    queryKey: ['achievements'],
    queryFn: async () => (await api.get('/student/gamification/achievements')).data,
  });
  if (isLoading) return <Skeleton className="h-64 rounded-3xl" />;
  const rows = data ?? [];
  const earned = rows.filter((r) => r.earned).length;

  const categories = Array.from(new Set(rows.map((r) => r.category)));
  return (
    <div className="space-y-8">
      <p className="text-sm text-on-surface-variant">
        {t('gamification.achievements.earnedOf', { earned, total: rows.length })}
      </p>
      {categories.map((c) => (
        <section key={c}>
          <h2 className="mb-3 font-heading text-lg font-extrabold">
            {t(`gamification.achievements.categories.${c}`, c)}
          </h2>
          <AchievementGrid rows={rows.filter((r) => r.category === c)} />
        </section>
      ))}
    </div>
  );
}

function RewardsTab() {
  const { t } = useTranslation();
  const L = useLocalized();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ coins: number; rewards: any[] }>({
    queryKey: ['rewards'],
    queryFn: async () => (await api.get('/student/gamification/rewards')).data,
  });

  const redeem = useMutation({
    mutationFn: async (rewardKey: string) =>
      (await api.post('/student/gamification/rewards/redeem', { rewardKey })).data,
    onSettled: () => {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['rewards'] });
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEY });
    },
  });

  if (isLoading) return <Skeleton className="h-64 rounded-3xl" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-heading text-lg font-extrabold">
          {t('gamification.rewards.balance', { count: data?.coins ?? 0 })}
        </p>
      </div>
      <p className="text-xs text-outline">{t('gamification.coinsHint')}</p>
      <ErrorNote error={redeem.error} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(data?.rewards ?? []).map((r) => (
          <div key={r.key} className="card flex flex-col">
            <span className="mb-2 grid h-11 w-11 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
              <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>{r.icon}</span>
            </span>
            <p className="font-heading font-bold">{L({ ar: r.titleAr, en: r.titleEn })}</p>
            <p className="mt-0.5 flex-1 text-sm text-on-surface-variant">{L({ ar: r.descAr, en: r.descEn })}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1 font-heading font-extrabold text-student-gold-ink">
                <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>toll</span>
                {r.costCoins}
              </span>
              <button
                type="button"
                className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
                disabled={!r.affordable || busy === r.key}
                onClick={() => { setBusy(r.key); redeem.mutate(r.key); }}
              >
                {busy === r.key
                  ? t('gamification.rewards.buying')
                  : r.affordable
                    ? t('gamification.rewards.buy')
                    : t('gamification.rewards.cant')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<any[]>({
    queryKey: ['gamification-activity'],
    queryFn: async () => (await api.get('/student/gamification/activity')).data,
  });
  if (isLoading) return <Skeleton className="h-64 rounded-3xl" />;
  if (!data?.length) {
    return <p className="card py-10 text-center text-sm text-on-surface-variant">{t('gamification.activity.empty')}</p>;
  }

  return (
    <Reveal className="card divide-y divide-outline-variant/50 p-0">
      {data.map((e) => (
        <div key={e.id} className="flex items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {t([`gamification.events.${e.type}`, e.type])}
          </span>
          <span className="shrink-0 text-sm font-bold text-primary">{e.xp > 0 ? `+${e.xp}` : ''}</span>
          <span className={`shrink-0 text-sm font-bold ${e.coins < 0 ? 'text-outline' : 'text-student-gold-ink'}`}>
            {e.coins !== 0 ? (e.coins > 0 ? `+${e.coins}` : e.coins) : ''}
          </span>
        </div>
      ))}
    </Reveal>
  );
}

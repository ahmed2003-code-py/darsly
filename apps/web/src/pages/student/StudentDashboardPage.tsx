import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ContinueWatchingItem, StudentProgressSummary } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { duration } from '../../lib/format';
import { useGamification, useLocalized } from '../../lib/gamification';
import { useAuthStore } from '../../stores/auth';
import { ProgressBar, Skeleton } from '../../components/ui';
import { Reveal, Stagger, StaggerItem } from '../../components/motion';
import { LevelCard, StreakAtRisk } from '../../components/gamification/LevelCard';
import { LeaderboardPanel } from '../../components/gamification/LeaderboardPanel';
import { MissionList } from '../../components/gamification/MissionList';

/**
 * Student home, arranged around the loop rather than around the data model.
 *
 * In three seconds it should answer: where am I, what do I do next, and what
 * happens if I do it. So the order is standing (level, streak, goal) → the
 * single resume action → today's missions → the board → everything else.
 */
export default function StudentDashboardPage() {
  const { t } = useTranslation();
  const L = useLocalized();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const { data: summary } = useQuery<StudentProgressSummary>({
    queryKey: ['progress-summary'],
    queryFn: async () => (await api.get('/progress/summary')).data,
  });
  const { data: g } = useGamification();
  const { data: watching, isLoading } = useQuery<ContinueWatchingItem[]>({
    queryKey: ['continue-watching'],
    queryFn: async () => (await api.get('/progress/continue-watching')).data,
  });

  const setGoal = useMutation({
    mutationFn: async (goal: number) => (await api.patch('/progress/weekly-goal', { goal })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['progress-summary'] }),
  });

  function editGoal() {
    const v = window.prompt(t('dashboardStudent.goalPrompt'), String(summary?.weeklyGoalLessons ?? 5));
    const n = Number(v);
    if (n >= 1 && n <= 50) setGoal.mutate(n);
  }

  const pct = summary?.weeklyGoalPct ?? 0;
  const ringDeg = (pct / 100) * 360;
  const resume = watching?.[0];

  return (
    <div className="page">
      <Reveal className="mb-6 border-s-2 border-primary ps-5">
        <h1 className="display text-on-surface">
          {t('dashboardStudent.greeting', { name: user?.fullName?.split(' ')[0] ?? '' })}
        </h1>
        <p className="mt-1 text-on-surface-variant">{t('dashboardStudent.subtitle')}</p>
      </Reveal>

      {g && (
        <div className="mb-6 space-y-4">
          <StreakAtRisk g={g} />
          <LevelCard g={g} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-6 lg:col-span-2">
          {/* The one action the page exists to offer. */}
          {resume && (
            <Reveal>
              <Link
                to={`/learn/${resume.courseId}/${resume.lessonId}`}
                className="card card-hover flex items-center gap-4 overflow-hidden"
              >
                <span className="relative hidden h-20 w-32 shrink-0 overflow-hidden rounded-xl bg-surface-container-high sm:block">
                  {resume.thumbnailUrl && <img src={resume.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-primary">{t('dashboardStudent.continueWatching')}</span>
                  <span className="block truncate font-heading text-lg font-extrabold">{resume.lessonTitle}</span>
                  <span className="mt-1.5 block">
                    <ProgressBar pct={resume.watchedPct} />
                  </span>
                  <span className="mt-1 block text-xs text-outline">
                    {duration(Math.max(0, resume.durationSec - resume.lastPositionSec))} · {resume.courseTitle}
                  </span>
                </span>
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
                  <span className="material-symbols-outlined text-3xl">play_arrow</span>
                </span>
              </Link>
            </Reveal>
          )}

          {g && g.missions.length > 0 && <MissionList missions={g.missions} kind="DAILY" />}

          <div>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-xl font-extrabold">{t('dashboardStudent.continueWatching')}</h2>
              <Link to="/my-courses" className="text-sm font-bold text-primary hover:underline">
                {t('dashboardStudent.viewAll')}
              </Link>
            </div>

            {isLoading ? (
              <div className="grid gap-5 sm:grid-cols-2">
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
              </div>
            ) : !watching?.length ? (
              <div className="card flex flex-col items-center gap-3 py-12 text-center">
                <span className="material-symbols-outlined text-5xl text-outline-variant">play_circle</span>
                <p className="font-bold text-on-surface-variant">{t('dashboardStudent.noContinue')}</p>
                <Link to="/discover" className="btn-primary mt-2">{t('dashboardStudent.browse')}</Link>
              </div>
            ) : (
              <Stagger className="grid gap-5 sm:grid-cols-2">
                {watching.slice(resume ? 1 : 0).map((w) => (
                  <StaggerItem key={w.lessonId}>
                    <Link to={`/learn/${w.courseId}/${w.lessonId}`} className="card card-hover flex h-full flex-col overflow-hidden p-0">
                      <div className="relative h-36 bg-surface-container-high">
                        {w.thumbnailUrl && <img src={w.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                        <span className="absolute inset-0 flex items-center justify-center">
                          <span className="grid h-12 w-12 place-items-center rounded-full bg-on-surface/60 text-surface backdrop-blur">
                            <span className="material-symbols-outlined text-3xl">play_arrow</span>
                          </span>
                        </span>
                        <span className="absolute bottom-2 end-2 rounded-md bg-on-surface/70 px-2 py-0.5 text-xs font-bold text-surface">
                          {w.watchedPct}%
                        </span>
                      </div>
                      <div className="flex flex-1 flex-col p-4">
                        <p className="truncate text-xs text-primary">{w.courseTitle}</p>
                        <h3 className="mb-1 truncate font-heading font-bold">{w.lessonTitle}</h3>
                        <p className="mb-3 text-xs text-outline">{w.teacherName}</p>
                        <div className="mt-auto">
                          <ProgressBar pct={w.watchedPct} />
                          <p className="mt-1 text-xs text-outline">
                            {duration(Math.max(0, w.durationSec - w.lastPositionSec))} · {t('dashboardStudent.resume')}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </StaggerItem>
                ))}
                {watching.length === 1 && resume && (
                  <Link to="/discover" className="card card-hover flex items-center justify-center gap-2 font-bold text-primary">
                    <span className="material-symbols-outlined">travel_explore</span>
                    {t('dashboardStudent.quickDiscover')}
                  </Link>
                )}
              </Stagger>
            )}
          </div>
        </section>

        <aside className="space-y-5">
          <div className="card">
            <h2 className="mb-4 text-center font-heading text-lg font-extrabold">
              {t('dashboardStudent.weeklyProgress')}
            </h2>
            <div
              className="mx-auto grid h-36 w-36 place-items-center rounded-full"
              style={{
                background: `conic-gradient(rgb(var(--c-primary)) ${ringDeg}deg, rgb(var(--c-surface-container-high)) ${ringDeg}deg)`,
              }}
            >
              <div className="grid h-28 w-28 place-items-center rounded-full bg-surface-container-lowest text-center">
                <div>
                  <p className="font-heading text-3xl font-extrabold text-primary">{pct}%</p>
                  <p className="text-xs text-on-surface-variant">{t('dashboardStudent.weeklyGoal')}</p>
                </div>
              </div>
            </div>
            <p className="mt-4 text-center text-sm text-on-surface-variant">
              {summary?.lessonsCompletedThisWeek ?? 0} / {summary?.weeklyGoalLessons ?? 5}{' '}
              {t('dashboardStudent.lessonsThisWeek')}
            </p>
            {pct >= 100 && (
              <p className="mt-2 rounded-lg bg-secondary-container/50 px-3 py-2 text-center text-sm font-bold text-on-secondary-container">
                {t('dashboardStudent.goalReached')}
              </p>
            )}
            <button className="btn-ghost mt-4 w-full py-2 text-sm" onClick={editGoal}>
              {t('dashboardStudent.editGoal')}
            </button>
          </div>

          <LeaderboardPanel scope="GLOBAL" compact />

          {g && g.achievements.recent.length > 0 && (
            <Link to="/learning" className="card card-hover">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-heading text-lg font-extrabold">{t('gamification.achievements.title')}</h2>
                <span className="text-xs text-outline">
                  {t('gamification.achievements.earnedOf', { earned: g.achievements.earned, total: g.achievements.total })}
                </span>
              </div>
              <div className="flex gap-2">
                {g.achievements.recent.slice(0, 4).map((a) => (
                  <span
                    key={a.key}
                    title={L({ ar: a.titleAr, en: a.titleEn })}
                    className="grid h-11 w-11 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed"
                  >
                    <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>
                      {a.icon}
                    </span>
                  </span>
                ))}
              </div>
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}

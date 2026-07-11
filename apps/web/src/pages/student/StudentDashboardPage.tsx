import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ContinueWatchingItem, StudentProgressSummary } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { duration } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { ProgressBar, Skeleton } from '../../components/ui';

/** Student home per the student_dashboard design: welcome + continue-watching
 *  rail + weekly progress ring + streak. */
export default function StudentDashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const { data: summary } = useQuery<StudentProgressSummary>({
    queryKey: ['progress-summary'],
    queryFn: async () => (await api.get('/progress/summary')).data,
  });
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

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      {/* Welcome banner */}
      <div className="card mb-8 flex flex-wrap items-center justify-between gap-4 bg-gradient-to-bl from-primary-fixed/70 to-surface-container-lowest">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-primary">
            {t('dashboardStudent.greeting', { name: user?.fullName?.split(' ')[0] ?? '' })}
          </h1>
          <p className="mt-1 text-on-surface-variant">{t('dashboardStudent.subtitle')}</p>
        </div>
        {summary && (
          <div className="flex items-center gap-2 rounded-full bg-amber-100 px-4 py-2 font-bold text-amber-800">
            <span className="material-symbols-outlined">local_fire_department</span>
            {t('dashboardStudent.streak', { count: summary.currentStreak })}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Continue watching */}
        <section className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-heading text-2xl font-extrabold">{t('dashboardStudent.continueWatching')}</h2>
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
            <div className="grid gap-5 sm:grid-cols-2">
              {watching.map((w) => (
                <Link
                  key={w.lessonId}
                  to={`/learn/${w.courseId}/${w.lessonId}`}
                  className="card card-hover flex flex-col overflow-hidden p-0"
                >
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
              ))}
            </div>
          )}
        </section>

        {/* Weekly progress + stats */}
        <aside className="space-y-5">
          <div className="card">
            <h2 className="mb-4 text-center font-heading text-xl font-extrabold">
              {t('dashboardStudent.weeklyProgress')}
            </h2>
            <div className="mx-auto grid h-40 w-40 place-items-center rounded-full"
              style={{ background: `conic-gradient(#422ec7 ${ringDeg}deg, #e7eeff ${ringDeg}deg)` }}>
              <div className="grid h-32 w-32 place-items-center rounded-full bg-surface-container-lowest text-center">
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

          <div className="grid grid-cols-2 gap-4">
            <div className="card text-center">
              <p className="font-heading text-3xl font-extrabold text-accent">{summary?.currentStreak ?? 0}</p>
              <p className="text-xs text-on-surface-variant">{t('dashboardStudent.streakLabel')}</p>
              <p className="mt-1 text-[11px] text-outline">
                {t('dashboardStudent.longest', { count: summary?.longestStreak ?? 0 })}
              </p>
            </div>
            <div className="card text-center">
              <p className="font-heading text-3xl font-extrabold text-primary">{summary?.totalLessonsCompleted ?? 0}</p>
              <p className="text-xs text-on-surface-variant">{t('dashboardStudent.completed')}</p>
              <p className="mt-1 text-[11px] text-outline">
                {summary?.activeCourses ?? 0} {t('dashboardStudent.activeCourses')}
              </p>
            </div>
          </div>

          <Link to="/discover" className="card card-hover flex items-center justify-center gap-2 font-bold text-primary">
            <span className="material-symbols-outlined">travel_explore</span>
            {t('dashboardStudent.quickDiscover')}
          </Link>
        </aside>
      </div>
    </div>
  );
}

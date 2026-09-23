import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { compactNum } from '../../lib/gamification';
import { Skeleton } from '../ui';

interface Overview {
  activeLearners: { today: number; week: number; month: number };
  returning: { thisWeek: number; lastWeek: number; returned: number; pct: number };
  last30Days: Record<string, number>;
  missions: { total: number; completed: number; pct: number };
  retention: { day: number; eligible: number; retained: number; pct: number }[];
  streaks: { average: number; longest: number; onAStreak: number };
  topLearners: {
    rank: number;
    name: string;
    avatarUrl: string | null;
    level: number;
    xp: number;
  }[];
}

/**
 * Engagement, for whoever is responsible for it — the same panel serves a
 * teacher looking at their academy and an admin looking at the platform.
 *
 * A metric with nothing behind it yet reads "—" rather than "0%". A brand-new
 * academy has not achieved zero retention; it has not been around long enough
 * to have any, and those are different facts.
 *
 * Cohort retention — what share of the students who started N days ago came
 * back — is a platform question, so it is shown to the admin and not to the
 * teacher. A teacher reads this page to see whether their own students are
 * turning up; three columns of "—" and a week-over-week return rate gave them
 * a dashboard to interpret instead of an answer, and the numbers they could
 * act on were the ones underneath it.
 */
export function EngagementPanel({ scope }: { scope: 'teacher' | 'admin' }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery<Overview>({
    queryKey: ['engagement', scope],
    queryFn: async () => (await api.get(`/${scope}/gamification/analytics`)).data,
  });

  if (isLoading) return <Skeleton className="h-64 rounded-3xl" />;
  if (!data) return null;

  const d = data.last30Days;
  const platformWide = scope === 'admin';

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 font-heading text-lg font-extrabold">{t('engagement.activeTitle')}</h2>
        <div
          className={`grid grid-cols-2 gap-3 ${platformWide ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}
        >
          <Metric value={data.activeLearners.today} label={t('engagement.today')} />
          <Metric value={data.activeLearners.week} label={t('engagement.week')} />
          <Metric value={data.activeLearners.month} label={t('engagement.month')} />
          {platformWide && (
            <Metric
              value={data.returning.lastWeek ? `${data.returning.pct}%` : '—'}
              label={t('engagement.returning')}
              hint={t('engagement.returningHint', {
                n: data.returning.returned,
                of: data.returning.lastWeek,
              })}
            />
          )}
        </div>
      </section>

      {platformWide && (
        <section>
          <h2 className="mb-3 font-heading text-lg font-extrabold">
            {t('engagement.retentionTitle')}
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {data.retention.map((r) => (
              <Metric
                key={r.day}
                value={r.eligible ? `${r.pct}%` : '—'}
                label={t('engagement.dayN', { n: r.day })}
                hint={
                  r.eligible
                    ? t('engagement.ofCohort', { n: r.eligible })
                    : t('engagement.tooEarly')
                }
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-heading text-lg font-extrabold">
          {t('engagement.learningTitle')}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric value={d.lessonsCompleted ?? 0} label={t('engagement.lessons')} />
          <Metric value={d.quizzesPassed ?? 0} label={t('engagement.quizzes')} />
          <Metric value={d.coursesCompleted ?? 0} label={t('engagement.courses')} />
          <Metric value={compactNum(d.xpAwarded ?? 0)} label={t('engagement.xp')} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 font-heading text-lg font-extrabold">{t('engagement.habitTitle')}</h2>
          <Row
            label={t('engagement.missionCompletion')}
            value={data.missions.total ? `${data.missions.pct}%` : '—'}
          />
          <Row label={t('engagement.onAStreak')} value={data.streaks.onAStreak} />
          <Row label={t('engagement.avgStreak')} value={data.streaks.average} />
          <Row label={t('engagement.longestStreak')} value={data.streaks.longest} />
        </section>

        <section className="card">
          <h2 className="mb-3 font-heading text-lg font-extrabold">
            {t('engagement.topLearners')}
          </h2>
          {!data.topLearners.length ? (
            <p className="py-6 text-center text-sm text-on-surface-variant">
              {t('engagement.noneYet')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {data.topLearners.slice(0, 5).map((l) => (
                <div
                  key={l.rank}
                  className="flex items-center gap-3 rounded-xl bg-surface-container-low px-3 py-2"
                >
                  <span className="w-6 text-center font-heading font-extrabold text-outline">
                    {l.rank}
                  </span>
                  <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-container-high text-xs font-bold">
                    {l.avatarUrl ? (
                      <img src={l.avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      l.name.trim().charAt(0)
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-bold">{l.name}</span>
                  <span className="shrink-0 text-sm font-extrabold text-student-gold-ink">
                    {compactNum(l.xp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ value, label, hint }: { value: string | number; label: string; hint?: string }) {
  return (
    <div className="card text-center">
      <p className="font-heading text-2xl font-extrabold text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-on-surface-variant">{label}</p>
      {hint && <p className="mt-0.5 text-[10px] text-outline">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-outline-variant/40 py-2 last:border-0">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <span className="font-heading font-extrabold">{value}</span>
    </div>
  );
}

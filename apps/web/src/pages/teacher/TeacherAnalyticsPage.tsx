import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { PageHeader, Skeleton } from '../../components/ui';

/** Dependency-free SVG bar chart (keeps the bundle lean). */
function BarChart({ data, format }: { data: { label: string; value: number }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex h-44 items-end gap-3 pt-6">
      {data.map((d, i) => {
        const h = (d.value / max) * 100;
        return (
          <div key={i} className="group flex flex-1 flex-col items-center gap-2">
            <div className="relative flex w-full flex-1 items-end">
              <div
                className="w-full rounded-t-lg bg-gradient-to-t from-primary-container to-primary transition-all duration-500 group-hover:opacity-90"
                style={{ height: `${Math.max(2, h)}%` }}
              />
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-bold text-on-surface-variant opacity-0 transition group-hover:opacity-100">
                {format ? format(d.value) : d.value}
              </span>
            </div>
            <span className="text-xs text-outline">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function TeacherAnalyticsPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['teacher-analytics'],
    queryFn: async () => (await api.get('/teacher/analytics')).data,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      </div>
    );
  }

  const kpis = [
    { icon: 'payments', label: t('analytics.gross'), value: egp(data.grossCents), tint: 'text-primary' },
    { icon: 'group', label: t('analytics.activeStudents'), value: data.activeStudents, tint: 'text-secondary' },
    { icon: 'task_alt', label: t('analytics.completion'), value: `${data.completionRatePct}%`, tint: 'text-primary' },
    { icon: 'quiz', label: t('analytics.quizPass'), value: `${data.quizPassRatePct}%`, tint: 'text-secondary' },
  ];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('analytics.title')} subtitle={t('analytics.subtitle')} />

      {/* KPIs */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="card flex items-center gap-4">
            <span className={`grid h-12 w-12 place-items-center rounded-2xl bg-primary-fixed ${k.tint}`}>
              <span className="material-symbols-outlined">{k.icon}</span>
            </span>
            <div>
              <p className="font-heading text-2xl font-extrabold">{k.value}</p>
              <p className="text-xs text-outline">{k.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-1 font-heading text-lg font-bold">{t('analytics.revenueTrend')}</h3>
          <p className="mb-2 text-xs text-outline">{t('analytics.last6Months')}</p>
          <BarChart data={data.revenueByMonth} format={(v) => egp(v)} />
        </div>
        <div className="card">
          <h3 className="mb-1 font-heading text-lg font-bold">{t('analytics.enrollmentsTrend')}</h3>
          <p className="mb-2 text-xs text-outline">{t('analytics.last6Months')}</p>
          <BarChart data={data.enrollmentsByMonth} />
        </div>
      </div>

      {/* Secondary row */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.topLessons')}</h3>
          {!data.topLessons?.length ? (
            <p className="py-6 text-center text-sm text-outline">{t('analytics.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {data.topLessons.map((l: any, i: number) => (
                <li key={l.lessonId} className="flex items-center gap-3">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-primary-fixed text-sm font-bold text-primary">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{l.title}</span>
                  <span className="text-xs text-outline">{t('analytics.views', { count: l.views })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card flex flex-col justify-center gap-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-on-surface-variant"><span className="material-symbols-outlined text-amber-500">star</span>{t('analytics.rating')}</span>
            <span className="font-heading text-xl font-extrabold">{data.avgRating ?? '—'} <span className="text-sm font-normal text-outline">({data.reviewsCount})</span></span>
          </div>
          <div className="flex items-center justify-between border-t border-outline-variant/40 pt-4">
            <span className="flex items-center gap-2 text-on-surface-variant"><span className="material-symbols-outlined text-primary">how_to_reg</span>{t('analytics.totalEnrollments')}</span>
            <span className="font-heading text-xl font-extrabold">{data.totalEnrollments}</span>
          </div>
          <div className="flex items-center justify-between border-t border-outline-variant/40 pt-4">
            <span className="flex items-center gap-2 text-on-surface-variant"><span className="material-symbols-outlined text-amber-600">pending_actions</span>{t('analytics.pending')}</span>
            <span className="font-heading text-xl font-extrabold">{data.pendingEnrollments}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

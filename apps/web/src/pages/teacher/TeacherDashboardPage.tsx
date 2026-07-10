import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { Badge, PageHeader, Skeleton } from '../../components/ui';

/** Teacher home per teacher_dashboard design: stat cards + latest enrollments. */
export default function TeacherDashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const { data: courses } = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
  });
  const { data: enrollments, isLoading } = useQuery({
    queryKey: ['teacher-enrollments', 'ALL'],
    queryFn: async () => (await api.get('/teacher/enrollments')).data,
  });

  const published = courses?.filter((c: any) => c.status === 'PUBLISHED').length ?? 0;
  const active = enrollments?.filter((e: any) => e.status === 'ACTIVE').length ?? 0;
  const pending = enrollments?.filter((e: any) => e.status === 'PENDING_APPROVAL').length ?? 0;
  const revenue =
    enrollments
      ?.filter((e: any) => e.status === 'ACTIVE' && e.payments?.[0]?.amountCents)
      .reduce((sum: number, e: any) => sum + e.payments[0].amountCents, 0) ?? 0;

  const stats = [
    { icon: 'menu_book', label: t('teacher.statCourses'), value: published, to: '/teacher/courses', tint: 'from-primary-fixed to-primary-fixed-dim text-primary' },
    { icon: 'groups', label: t('teacher.statStudents'), value: active, to: '/teacher/students', tint: 'from-secondary-container to-secondary-fixed-dim text-on-secondary-container' },
    { icon: 'pending_actions', label: t('teacher.statPending'), value: pending, to: '/teacher/students', tint: 'from-amber-100 to-amber-200 text-amber-700' },
    { icon: 'payments', label: t('teacher.statRevenue'), value: egp(revenue), to: '/teacher/students', tint: 'from-primary-fixed to-secondary-container text-primary' },
  ];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title={t('teacher.overviewTitle')}
        subtitle={`${t('dashboard.welcome', { name: user?.fullName })} — ${t('teacher.overviewSubtitle')}`}
        action={
          <Link to="/teacher/courses" className="btn-primary">
            <span className="material-symbols-outlined">add</span>
            {t('teacher.newCourse')}
          </Link>
        }
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} to={s.to} className="card card-hover flex items-center gap-4 p-5">
            <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${s.tint}`}>
              <span className="material-symbols-outlined text-3xl">{s.icon}</span>
            </span>
            <div className="min-w-0">
              <p className="font-heading text-2xl font-extrabold tabular-nums">{s.value}</p>
              <p className="truncate text-sm text-on-surface-variant">{s.label}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-xl font-bold">{t('teacher.latestEnrollments')}</h2>
          <Link to="/teacher/students" className="text-sm font-bold text-primary hover:underline">
            {t('teacher.viewAll')}
          </Link>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : !enrollments?.length ? (
          <p className="py-10 text-center text-outline">{t('teacher.noEnrollments')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {enrollments.slice(0, 6).map((e: any) => (
              <li key={e.id} className="flex items-center gap-4 py-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                  {e.student.user.fullName?.trim()?.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{e.student.user.fullName}</p>
                  <p className="truncate text-sm text-on-surface-variant">{e.course.title}</p>
                </div>
                <div className="text-end">
                  <Badge tone={e.status === 'ACTIVE' ? 'teal' : e.status === 'PENDING_APPROVAL' ? 'warn' : 'neutral'}>
                    {t(`myCourses.status.${e.status}`)}
                  </Badge>
                  <p className="mt-1 text-xs text-outline">
                    {dateShort(e.createdAt)}
                    {e.payments?.[0] ? ` · ${egp(e.payments[0].amountCents)}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

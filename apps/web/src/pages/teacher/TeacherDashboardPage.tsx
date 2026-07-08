import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { Badge, Spinner } from '../../components/ui';

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

  const stats = [
    { icon: 'menu_book', label: t('teacher.statCourses'), value: published, to: '/teacher/courses' },
    { icon: 'group', label: t('teacher.statStudents'), value: active, to: '/teacher/students' },
    { icon: 'pending_actions', label: t('teacher.statPending'), value: pending, to: '/teacher/students' },
  ];

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-4xl font-extrabold">{t('teacher.overviewTitle')}</h1>
          <p className="mt-2 text-on-surface-variant">
            {t('dashboard.welcome', { name: user?.fullName })} — {t('teacher.overviewSubtitle')}
          </p>
        </div>
        <Link to="/teacher/courses" className="btn-primary flex items-center gap-2">
          <span className="material-symbols-outlined">upload_file</span>
          {t('teacher.newCourse')}
        </Link>
      </div>

      <div className="mb-8 grid gap-5 sm:grid-cols-3">
        {stats.map((s) => (
          <Link key={s.label} to={s.to} className="card flex items-center gap-4 transition hover:shadow-modal">
            <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary-fixed text-primary">
              <span className="material-symbols-outlined text-3xl">{s.icon}</span>
            </span>
            <div>
              <p className="font-heading text-3xl font-extrabold">{s.value}</p>
              <p className="text-sm text-on-surface-variant">{s.label}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-xl font-bold">{t('teacher.latestEnrollments')}</h2>
          <Link to="/teacher/students" className="text-sm text-primary hover:underline">
            {t('teacher.viewAll')}
          </Link>
        </div>
        {isLoading ? (
          <Spinner />
        ) : !enrollments?.length ? (
          <p className="py-8 text-center text-outline">{t('teacher.noEnrollments')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {enrollments.slice(0, 6).map((e: any) => (
              <li key={e.id} className="flex items-center gap-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                  {e.student.user.fullName?.trim()?.charAt(0)}
                </div>
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

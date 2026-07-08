import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, EmptyState, Spinner } from '../../components/ui';

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  ACTIVE: 'teal',
  PENDING_APPROVAL: 'warn',
  REJECTED: 'error',
  REVOKED: 'error',
  EXPIRED: 'neutral',
};

export default function MyCoursesPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['my-enrollments'],
    queryFn: async () => (await api.get('/enrollments/mine')).data,
  });

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      <h1 className="font-heading text-4xl font-extrabold">{t('myCourses.title')}</h1>
      <p className="mb-8 mt-2 text-on-surface-variant">{t('myCourses.subtitle')}</p>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <div>
          <EmptyState icon="auto_stories" title={t('myCourses.empty')} hint={t('myCourses.emptyHint')} />
          <div className="mt-4 text-center">
            <Link to="/" className="btn-primary inline-block">{t('myCourses.browse')}</Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((e: any) => (
            <Link key={e.id} to={`/course/${e.course.id}`} className="card flex flex-col overflow-hidden p-0 transition hover:shadow-modal">
              <div className="relative h-40 bg-surface-container-high">
                {e.course.thumbnailUrl && (
                  <img src={e.course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                )}
                <span className="absolute start-3 top-3">
                  <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{t(`myCourses.status.${e.status}`)}</Badge>
                </span>
              </div>
              <div className="flex flex-1 flex-col p-5">
                <h3 className="mb-1 font-heading text-lg font-bold">{e.course.title}</h3>
                <p className="mb-3 text-sm text-primary">{e.course.teacherName}</p>
                <div className="mt-auto flex items-center justify-between text-xs text-outline">
                  <span>{t('course.lessonsCount', { count: e.course.lessonsCount })}</span>
                  {e.expiresAt ? (
                    <span>{t('myCourses.expiresAt', { date: dateShort(e.expiresAt) })}</span>
                  ) : (
                    <span>{egp(e.course.priceCents)}</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

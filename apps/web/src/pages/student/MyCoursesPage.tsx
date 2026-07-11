import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, CardGridSkeleton, EmptyState, PageHeader, ProgressBar } from '../../components/ui';

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  ACTIVE: 'teal',
  PENDING_APPROVAL: 'warn',
  REJECTED: 'error',
  REVOKED: 'error',
  EXPIRED: 'neutral',
};

export default function MyCoursesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['my-enrollments'],
    queryFn: async () => (await api.get('/enrollments/mine')).data,
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('myCourses.title')} subtitle={t('myCourses.subtitle')} />

      {isLoading ? (
        <CardGridSkeleton count={3} />
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

                {e.status === 'ACTIVE' && e.course.lessonsCount > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 flex items-center justify-between text-xs text-outline">
                      <span>{t('myCourses.progress')}</span>
                      <span className="font-bold text-on-surface-variant">
                        {e.completedLessons}/{e.course.lessonsCount} · {e.progressPct}%
                      </span>
                    </div>
                    <ProgressBar pct={e.progressPct} tone={e.progressPct >= 100 ? 'accent' : 'primary'} />
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between text-xs text-outline">
                  <span>{t('course.lessonsCount', { count: e.course.lessonsCount })}</span>
                  {e.expiresAt ? (
                    <span>{t('myCourses.expiresAt', { date: dateShort(e.expiresAt) })}</span>
                  ) : (
                    <span>{egp(e.course.priceCents)}</span>
                  )}
                </div>

                {e.certificateSerial && (
                  <span
                    className="mt-3 flex items-center justify-center gap-1 rounded-lg border border-primary-container/60 bg-primary-fixed/40 py-2 text-sm font-bold text-primary"
                    onClick={(ev) => { ev.preventDefault(); navigate(`/certificate/${e.certificateSerial}`); }}
                  >
                    <span className="material-symbols-outlined text-base">workspace_premium</span>
                    {t('myCourses.viewCertificate')}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

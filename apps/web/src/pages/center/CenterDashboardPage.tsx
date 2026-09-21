import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AcademyStatus } from '@darsly/shared-types';
import { useAuthStore } from '../../stores/auth';
import { useOwnedAcademy } from '../../lib/academy';
import { Badge, EmptyState, PageHeader, Skeleton } from '../../components/ui';

/**
 * The Center Admin's home. Deliberately not the teacher dashboard: a STAFF
 * account has no courses, wallet or storefront of its own. Every card links to
 * an existing academy-scoped screen that already authorises from membership.
 */
export default function CenterDashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { academy, isLoading } = useOwnedAcademy();

  if (isLoading) return <div className="page"><Skeleton className="h-32 rounded-2xl" /></div>;
  if (!academy) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;

  const cards = [
    { to: '/center/members', icon: 'group', title: t('center.members'), sub: t('center.membersSub') },
    { to: '/center/subjects', icon: 'menu_book', title: t('center.subjects'), sub: t('center.subjectsSub') },
    { to: '/teacher/groups', icon: 'diversity_3', title: t('center.groups'), sub: t('center.groupsSub') },
    { to: '/teacher/schedule', icon: 'calendar_month', title: t('center.schedule'), sub: t('center.scheduleSub') },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('center.welcome', { name: user?.fullName ?? '' })}
        subtitle={t('center.subtitle', { center: academy.name })}
        action={<Badge tone={academy.status === AcademyStatus.ACTIVE ? 'teal' : 'warn'}>{t(`admin.academyStatus.${academy.status}`)}</Badge>}
      />
      {academy.status === AcademyStatus.SUSPENDED && (
        <p className="mb-4 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container">{t('center.statusSuspended')}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.to} to={c.to} className="card card-hover flex items-start gap-4 p-5">
            <span className="material-symbols-outlined text-3xl text-primary">{c.icon}</span>
            <div>
              <p className="font-heading font-bold">{c.title}</p>
              <p className="text-sm text-on-surface-variant">{c.sub}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

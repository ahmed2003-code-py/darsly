import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AcademyStatus } from '@darsly/shared-types';
import { useAuthStore } from '../../stores/auth';
import { useOwnedAcademy } from '../../lib/academy';
import { useCenterOverview } from '../../lib/analytics';
import { dateShort } from '../../lib/format';
import { Badge, EmptyState, PageHeader, Skeleton } from '../../components/ui';

/**
 * The Center Admin's home. Every number comes from GET teacher/analytics/center,
 * which is organisation-scoped (academyId) and owner-only server-side — a
 * STAFF account has no courses, wallet or storefront of its own, and no
 * financial figure appears here (that is a later phase).
 */
export default function CenterDashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { academy, isLoading } = useOwnedAcademy();
  const { data: ov, isLoading: loadingOv } = useCenterOverview();

  if (isLoading) return <div className="page"><Skeleton className="h-32 rounded-2xl" /></div>;
  if (!academy) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;

  const tiles = ov ? [
    { icon: 'school', label: t('center.kpi.teachers'), value: ov.teachers },
    { icon: 'groups', label: t('center.kpi.students'), value: ov.students },
    { icon: 'video_library', label: t('center.kpi.courses'), value: `${ov.courses.published}/${ov.courses.total}` },
    { icon: 'diversity_3', label: t('center.kpi.groups'), value: ov.groups },
    { icon: 'event_upcoming', label: t('center.kpi.upcoming'), value: ov.sessions.upcoming7d },
    { icon: 'fact_check', label: t('center.kpi.attendance'), value: ov.attendance.presentRate == null ? '—' : `${ov.attendance.presentRate}%` },
    ...(ov.subjectsActive != null ? [{ icon: 'menu_book', label: t('center.kpi.subjects'), value: ov.subjectsActive }] : []),
  ] : [];

  const cards = [
    { to: '/center/members', icon: 'group', title: t('center.members'), sub: t('center.membersSub') },
    { to: '/teacher/courses', icon: 'video_library', title: t('center.courses'), sub: t('center.coursesSub') },
    { to: '/teacher/groups', icon: 'diversity_3', title: t('center.groups'), sub: t('center.groupsSub') },
    { to: '/teacher/schedule', icon: 'calendar_month', title: t('center.schedule'), sub: t('center.scheduleSub') },
    { to: '/center/subjects', icon: 'menu_book', title: t('center.subjects'), sub: t('center.subjectsSub') },
    { to: '/teacher/analytics', icon: 'monitoring', title: t('center.analytics'), sub: t('center.analyticsSub') },
    { to: '/center/studio', icon: 'palette', title: t('centerStudio.title'), sub: t('centerStudio.tileSub') },
    { to: '/center/settings', icon: 'settings', title: t('center.settings'), sub: t('center.settingsSub') },
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
      {loadingOv ? (
        <Skeleton className="mb-6 h-24 rounded-2xl" />
      ) : (
        <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {tiles.map((k) => (
            <div key={k.label} className="card flex items-center gap-3 p-4">
              <span className="material-symbols-outlined text-2xl text-primary">{k.icon}</span>
              <div className="min-w-0">
                <p className="truncate text-xs text-outline">{k.label}</p>
                <p className="font-heading text-xl font-bold tabular-nums">{k.value}</p>
              </div>
            </div>
          ))}
        </div>
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
      {ov && ov.recentActivity.length > 0 && (
        <div className="card mt-6 p-0">
          <p className="border-b border-outline-variant px-5 py-3 font-heading font-bold">{t('center.recentActivity')}</p>
          <ul className="divide-y divide-outline-variant">
            {ov.recentActivity.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="truncate"><code className="text-xs">{a.action}</code>{a.by ? ` — ${a.by}` : ''}</span>
                <span className="shrink-0 text-xs text-outline">{dateShort(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

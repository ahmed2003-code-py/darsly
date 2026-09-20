import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { egp } from '../../lib/format';
import {
  GrowthRange,
  useAdminGrowthTrend,
  useAdminOverview,
  useAdminRevenueTrend,
} from '../../lib/adminCommandCenter';
import { useActiveAcademyRate, usePlatformAttendance, usePlatformFinancial } from '../../lib/analytics';
import { BarChart, PageHeader, Skeleton } from '../../components/ui';

const RANGES: GrowthRange[] = [7, 30, 90];

/** Phase 6: platform-wide attendance, payment conversion, and academy
 *  activity — additive to the Phase 2 Command Center, not a rebuild of it. */
function PlatformAnalyticsSection() {
  const { t } = useTranslation();
  const [range, setRange] = useState<GrowthRange>(30);
  const attendance = usePlatformAttendance(range);
  const financial = usePlatformFinancial(range);
  const activeAcademies = useActiveAcademyRate(range);
  const loading = attendance.isLoading || financial.isLoading || activeAcademies.isLoading;

  return (
    <section className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-bold">{t('admin.platformAnalytics.title')}</h2>
        <div className="flex gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${
                range === r ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'
              }`}
            >
              {t('admin.rangeDays', { count: r })}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{attendance.data?.attendanceRatePct ?? '—'}%</p>
            <p className="text-xs text-outline">{t('admin.platformAnalytics.attendanceRate')}</p>
          </div>
          <div className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{activeAcademies.data?.ratePct ?? '—'}%</p>
            <p className="text-xs text-outline">
              {t('admin.platformAnalytics.activeAcademyRate', {
                n: activeAcademies.data?.academiesWithRecentEnrollment ?? 0,
                of: activeAcademies.data?.totalActiveAcademies ?? 0,
              })}
            </p>
          </div>
          <div className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{financial.data?.paymentConversion.convertedPct ?? '—'}%</p>
            <p className="text-xs text-outline">{t('admin.platformAnalytics.conversion')}</p>
          </div>
          <div className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{financial.data?.paymentConversion.pending ?? 0}</p>
            <p className="text-xs text-outline">{t('admin.platformAnalytics.pendingReview')}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function TrendSection() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<GrowthRange>(30);
  const growth = useAdminGrowthTrend(range);
  const revenue = useAdminRevenueTrend(range);
  const loading = growth.isLoading || revenue.isLoading;

  const dayLabel = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' });

  // Dense ranges (30/90 days) would cram unreadable bars — thin the labels
  // shown under the chart without dropping any of the underlying data points.
  const thinned = <T,>(points: T[]) => {
    const step = Math.ceil(points.length / 12);
    return points.filter((_, i) => i % step === 0 || i === points.length - 1);
  };

  return (
    <section className="card mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-bold">{t('admin.trends')}</h2>
        <div className="flex gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${
                range === r ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'
              }`}
            >
              {t('admin.rangeDays', { count: r })}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-44 rounded-xl" />
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-bold text-on-surface-variant">{t('admin.revenueTrend')}</p>
            <BarChart
              data={thinned(revenue.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.grossCents }))}
              format={egp}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-bold text-on-surface-variant">{t('admin.enrollmentTrend')}</p>
            <BarChart
              data={thinned(growth.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.enrollments }))}
            />
          </div>
        </div>
      )}
    </section>
  );
}

export default function AdminOverviewPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useAdminOverview();

  if (isLoading || !data) {
    return (
      <div className="page">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const money = [
    // The single filled accent moment on the page — the headline number.
    { label: t('admin.gross'), value: egp(data.grossCents), icon: 'trending_up', card: 'bg-primary text-on-primary border-transparent', iconBg: 'bg-white/15' },
    { label: t('admin.commission'), value: egp(data.commissionCents), icon: 'account_balance', card: 'bg-surface-container-lowest text-on-surface', iconBg: 'bg-primary-fixed text-on-primary-fixed' },
  ];
  const counts = [
    { label: t('admin.academiesTotal'), value: data.totalAcademies, icon: 'apartment', to: '/admin/academies' },
    { label: t('admin.academiesActive'), value: data.activeAcademies, icon: 'domain_verification', to: '/admin/academies?status=ACTIVE' },
    { label: t('admin.students'), value: data.students, icon: 'school', to: undefined },
    { label: t('admin.teachers'), value: data.teachersApproved, icon: 'groups', to: '/admin/teachers' },
    { label: t('admin.pendingTeachers'), value: data.teachersPending, icon: 'pending_actions', to: '/admin/teachers?status=PENDING', highlight: data.teachersPending > 0 },
    { label: t('admin.courses'), value: data.coursesPublished, icon: 'menu_book' },
    { label: t('admin.activeEnrollments'), value: data.activeEnrollments, icon: 'workspace_premium' },
    { label: t('admin.totalEnrollments'), value: data.totalEnrollments, icon: 'assignment_turned_in' },
    { label: t('admin.pendingPayouts'), value: data.pendingPayouts, icon: 'payments', to: '/admin/payouts', highlight: data.pendingPayouts > 0 },
    { label: t('admin.studioTile'), value: t('admin.studioTileValue'), icon: 'rate_review', to: '/admin/academy-studio' },
  ];

  return (
    <div className="page">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        {money.map((m) => (
          <div key={m.icon} className={`card flex items-center gap-4 ${m.card}`}>
            <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-xl ${m.iconBg}`}>
              <span className="material-symbols-outlined text-3xl">{m.icon}</span>
            </span>
            <div>
              <p className="text-sm opacity-80">{m.label}</p>
              <p className="font-heading text-3xl font-bold tracking-tight tabular-nums">{m.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {counts.map((c) => {
          const inner = (
            <div className={`card card-hover flex items-center gap-4 ${c.highlight ? 'ring-2 ring-primary' : ''}`}>
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
                <span className="material-symbols-outlined text-2xl">{c.icon}</span>
              </span>
              <div>
                <p className="font-heading text-2xl font-extrabold tabular-nums">{c.value}</p>
                <p className="text-sm text-on-surface-variant">{c.label}</p>
              </div>
            </div>
          );
          return c.to ? <Link key={c.icon} to={c.to}>{inner}</Link> : <div key={c.icon}>{inner}</div>;
        })}
      </div>

      <TrendSection />
      <PlatformAnalyticsSection />
    </div>
  );
}

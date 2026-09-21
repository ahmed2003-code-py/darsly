import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMyAcademies } from '../../lib/academy';
import { useStaffAcademyStore } from '../../stores/staffAcademy';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import {
  AnalyticsRange,
  useAttendanceStats,
  useCoursesAnalytics,
  useEnrollmentBreakdown,
  useFinancialOverview,
  useGroupsAnalytics,
  useGrowth,
  useSchedulingOverview,
  useStaffAnalytics,
  useStudentsOverview,
  useMyTeaching,
} from '../../lib/analytics';
import { Badge, BarChart, EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';
import { EngagementPanel } from '../../components/gamification/EngagementPanel';

const RANGES: AnalyticsRange[] = [7, 30, 90];
const TABS = ['overview', 'growth', 'enrollments', 'attendance', 'groups', 'scheduling', 'courses', 'teachers', 'financial'] as const;
type Tab = (typeof TABS)[number];

function RangeSwitch({ range, onChange }: { range: AnalyticsRange; onChange: (r: AnalyticsRange) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${
            range === r ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'
          }`}
        >
          {t('admin.rangeDays', { count: r })}
        </button>
      ))}
    </div>
  );
}

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Dense ranges (30/90 days) would cram unreadable bars — thin the labels
// without dropping any of the underlying data points.
function thinned<T>(points: T[]): T[] {
  const step = Math.ceil(points.length / 12);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

function GrowthTab({ range }: { range: AnalyticsRange }) {
  const { t } = useTranslation();
  const students = useStudentsOverview(range);
  const growth = useGrowth(range);
  if (students.isLoading || growth.isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (students.error || growth.error) return <ErrorNote error={students.error ?? growth.error} />;
  const s = students.data!;
  const cards = [
    { label: t('analytics.students.total'), value: s.totalEnrolledStudents },
    { label: t('analytics.students.active'), value: s.activeStudents },
    { label: t('analytics.students.new'), value: s.newStudents },
    { label: t('analytics.students.returning'), value: s.returning.lastWeek ? `${s.returning.pct}%` : '—' },
    { label: t('analytics.students.inactive'), value: s.inactiveStudents },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{c.value}</p>
            <p className="text-xs text-outline">{c.label}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-outline">{t('analytics.students.inactiveHint', { days: s.inactivityThresholdDays })}</p>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.growth.newStudents')}</h3>
          <BarChart data={thinned(growth.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.newStudents }))} />
        </div>
        <div className="card">
          <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.growth.newEnrollments')}</h3>
          <BarChart data={thinned(growth.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.newEnrollments }))} />
        </div>
        <div className="card">
          <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.growth.activated')}</h3>
          <BarChart data={thinned(growth.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.activatedEnrollments }))} />
        </div>
        <div className="card">
          <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.growth.courseActivity')}</h3>
          <BarChart data={thinned(growth.data ?? []).map((p) => ({ label: dayLabel(p.date), value: p.courseActivity }))} />
        </div>
      </div>
    </div>
  );
}

function EnrollmentsTab() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useEnrollmentBreakdown();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  const d = data!;
  const statusRows: [string, number][] = [
    [t('teacher.students.status.ACTIVE'), d.byStatus.active],
    [t('teacher.students.status.PENDING_PAYMENT'), d.byStatus.pendingPayment],
    [t('teacher.students.status.PENDING_APPROVAL'), d.byStatus.pendingApproval],
    [t('teacher.students.status.REJECTED'), d.byStatus.rejected],
    [t('teacher.students.status.REVOKED'), d.byStatus.revoked],
    [t('teacher.students.status.EXPIRED'), d.byStatus.expired],
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="card">
        <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.enrollments.byStatus')}</h3>
        <ul className="space-y-2">
          {statusRows.map(([label, value]) => (
            <li key={label} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
              <span className="text-sm text-on-surface-variant">{label}</span>
              <span className="font-heading font-bold tabular-nums">{value}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        <h3 className="mb-1 font-heading text-lg font-bold">{t('analytics.enrollments.bySource')}</h3>
        <p className="mb-3 text-xs text-outline">{t('analytics.enrollments.bySourceHint')}</p>
        <ul className="space-y-2">
          <li className="flex items-center justify-between border-b border-outline-variant/30 py-2">
            <span className="text-sm text-on-surface-variant">{t('academy.enrollmentMode.AUTOMATIC')}</span>
            <span className="font-heading font-bold tabular-nums">{d.activeBySource.automatic}</span>
          </li>
          <li className="flex items-center justify-between border-b border-outline-variant/30 py-2">
            <span className="text-sm text-on-surface-variant">{t('academy.enrollmentMode.MANUAL')}</span>
            <span className="font-heading font-bold tabular-nums">{d.activeBySource.manual}</span>
          </li>
          <li className="flex items-center justify-between py-2">
            <span className="text-sm text-on-surface-variant">{t('analytics.enrollments.demo')}</span>
            <span className="font-heading font-bold tabular-nums">{d.activeBySource.demo}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function AttendanceTab({ range }: { range: AnalyticsRange }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useAttendanceStats(range);
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  const d = data!;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="card bg-primary text-on-primary">
          <p className="font-heading text-2xl font-extrabold tabular-nums">{d.attendanceRatePct ?? '—'}%</p>
          <p className="text-xs opacity-80">{t('analytics.attendance.rate')}</p>
        </div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.counts.present}</p><p className="text-xs text-outline">{t('groups.status.PRESENT')}</p></div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.counts.absent}</p><p className="text-xs text-outline">{t('groups.status.ABSENT')}</p></div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.counts.late}</p><p className="text-xs text-outline">{t('groups.status.LATE')}</p></div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.counts.excused}</p><p className="text-xs text-outline">{t('groups.status.EXCUSED')}</p></div>
      </div>
      <div className="card">
        <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.attendance.trend')}</h3>
        <BarChart data={thinned(d.trend).map((p) => ({ label: dayLabel(p.date), value: p.ratePct ?? 0 }))} format={(v) => `${v}%`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.attendance.byGroup')}</h3>
          {!d.byGroup.length ? (
            <p className="py-6 text-center text-sm text-outline">{t('analytics.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {d.byGroup.map((g) => (
                <li key={g.groupId} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                  <span className="text-sm">{g.name}</span>
                  <span className="font-heading font-bold tabular-nums">{g.ratePct ?? '—'}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.attendance.atRisk')}</h3>
          {!d.atRisk.length ? (
            <p className="py-6 text-center text-sm text-outline">{t('analytics.attendance.noAtRisk')}</p>
          ) : (
            <ul className="space-y-2">
              {d.atRisk.map((r) => (
                <li key={`${r.studentId}-${r.groupId}`} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                  <span className="text-sm">{r.fullName} <span className="text-xs text-outline">· {r.groupName}</span></span>
                  <Badge tone="error">{t('analytics.attendance.streak', { count: r.streak })}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupsTab() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGroupsAnalytics();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  if (!data!.groups.length) return <EmptyState icon="diversity_3" title={t('analytics.groups.empty')} />;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-outline-variant/40 text-on-surface-variant">
            <th className="px-6 py-4 text-start font-bold">{t('groups.name')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.groups.students')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.attendance.rate')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.groups.sessions')}</th>
          </tr>
        </thead>
        <tbody>
          {data!.groups.map((g) => (
            <tr key={g.id} className="border-b border-outline-variant/30 last:border-0">
              <td className="px-6 py-4 font-bold">{g.name}</td>
              <td className="px-6 py-4 tabular-nums">{g.studentsCount}</td>
              <td className="px-6 py-4 tabular-nums">{g.attendanceRatePct ?? '—'}%</td>
              <td className="px-6 py-4 tabular-nums">
                {t('analytics.groups.sessionsBreakdown', { done: g.sessionsCompleted, cancelled: g.sessionsCancelled, upcoming: g.sessionsUpcoming })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchedulingTab({ range }: { range: AnalyticsRange }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useSchedulingOverview(range);
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  const d = data!;
  const cards = [
    { label: t('analytics.scheduling.completed'), value: d.completed },
    { label: t('analytics.scheduling.cancelled'), value: d.cancelled },
    { label: t('analytics.scheduling.upcoming'), value: d.upcoming },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <p className="font-heading text-2xl font-extrabold tabular-nums">{c.value}</p>
            <p className="text-xs text-outline">{c.label}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card">
          <h3 className="mb-1 font-heading text-lg font-bold">{t('analytics.scheduling.roomUsage')}</h3>
          <p className="mb-3 text-xs text-outline">{t('analytics.scheduling.roomUsageHint')}</p>
          {!d.roomUsage.length ? <p className="py-4 text-center text-sm text-outline">{t('analytics.noData')}</p> : (
            <ul className="space-y-2">
              {d.roomUsage.map((r) => (
                <li key={r.roomId} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                  <span className="text-sm">{r.name}</span>
                  <span className="text-xs text-outline tabular-nums">{t('analytics.scheduling.sessionsMinutes', { sessions: r.sessions, minutes: r.scheduledMinutes })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.scheduling.teacherLoad')}</h3>
          {!d.teacherLoad.length ? <p className="py-4 text-center text-sm text-outline">{t('analytics.noData')}</p> : (
            <ul className="space-y-2">
              {d.teacherLoad.map((r) => (
                <li key={r.userId} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                  <span className="text-sm">{r.fullName}</span>
                  <span className="font-heading font-bold tabular-nums">{r.sessions}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.scheduling.groupLoad')}</h3>
          {!d.groupLoad.length ? <p className="py-4 text-center text-sm text-outline">{t('analytics.noData')}</p> : (
            <ul className="space-y-2">
              {d.groupLoad.map((r) => (
                <li key={r.groupId} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                  <span className="text-sm">{r.name}</span>
                  <span className="font-heading font-bold tabular-nums">{r.sessions}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CoursesTab() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useCoursesAnalytics();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  if (!data!.length) return <EmptyState icon="menu_book" title={t('analytics.courses.empty')} />;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-outline-variant/40 text-on-surface-variant">
            <th className="px-6 py-4 text-start font-bold">{t('analytics.courses.course')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.totalEnrollments')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.activeStudents')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.completion')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.quizPass')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {data!.map((c) => (
            <tr key={c.courseId} className="border-b border-outline-variant/30 last:border-0">
              <td className="px-6 py-4 font-bold">{c.title}</td>
              <td className="px-6 py-4 tabular-nums">{c.totalEnrollments}</td>
              <td className="px-6 py-4 tabular-nums">{c.activeStudents}</td>
              <td className="px-6 py-4 tabular-nums">{c.avgProgressPct}%</td>
              <td className="px-6 py-4 tabular-nums">{c.quizPassRatePct ?? '—'}%</td>
              <td className="px-6 py-4 font-heading font-bold tabular-nums">{egp(c.revenueNetCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeachersTab() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useStaffAnalytics();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  if (!data!.length) return <EmptyState icon="groups" title={t('analytics.teachers.empty')} />;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-outline-variant/40 text-on-surface-variant">
            <th className="px-6 py-4 text-start font-bold">{t('analytics.teachers.name')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.teachers.role')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.teachers.groups')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.teachers.sessions')}</th>
            <th className="px-6 py-4 text-start font-bold">{t('analytics.attendance.rate')}</th>
          </tr>
        </thead>
        <tbody>
          {data!.map((s) => (
            <tr key={s.userId} className="border-b border-outline-variant/30 last:border-0">
              <td className="px-6 py-4 font-bold">{s.fullName}</td>
              <td className="px-6 py-4"><Badge tone="neutral">{t(`admin.staffRole.${s.role}`)}</Badge></td>
              <td className="px-6 py-4 tabular-nums">{s.groupsAssigned}</td>
              <td className="px-6 py-4 tabular-nums">{s.sessionsRun}</td>
              <td className="px-6 py-4 tabular-nums">{s.attendanceRatePct ?? '—'}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinancialTab({ range }: { range: AnalyticsRange }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useFinancialOverview(range);
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error) return <ErrorNote error={error} />;
  const d = data!;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card bg-primary text-on-primary">
          <p className="font-heading text-2xl font-extrabold tabular-nums">{egp(d.lifetimeNetCents)}</p>
          <p className="text-xs opacity-80">{t('analytics.financial.lifetime')}</p>
        </div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.paidTransactions}</p><p className="text-xs text-outline">{t('analytics.financial.paid')}</p></div>
        <div className="card"><p className="font-heading text-2xl font-extrabold tabular-nums">{d.pendingPayments}</p><p className="text-xs text-outline">{t('analytics.financial.pending')}</p></div>
      </div>
      <div className="card">
        <h3 className="mb-2 font-heading text-lg font-bold">{t('analytics.financial.trend')}</h3>
        <BarChart data={thinned(d.netRevenueTrend).map((p) => ({ label: dayLabel(p.date), value: p.netCents }))} format={egp} />
      </div>
      <div className="card">
        <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.financial.byCourse')}</h3>
        {!d.revenueByCourse.length ? (
          <p className="py-6 text-center text-sm text-outline">{t('analytics.noData')}</p>
        ) : (
          <ul className="space-y-2">
            {d.revenueByCourse.map((c) => (
              <li key={c.courseId} className="flex items-center justify-between border-b border-outline-variant/30 py-2 last:border-0">
                <span className="text-sm">{c.title}</span>
                <span className="font-heading font-bold tabular-nums">{egp(c.netCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A non-owner member's own numbers inside the active academy — never the Center-wide view. */
function MyTeachingView({ range, onRange }: { range: AnalyticsRange; onRange: (r: AnalyticsRange) => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useMyTeaching(range);
  if (isLoading || !data) return <Skeleton className="h-40 rounded-2xl" />;
  const tiles = [
    { label: t('analytics.me.courses'), value: data.courses },
    { label: t('analytics.me.enrollments'), value: data.activeEnrollments },
    { label: t('analytics.me.groups'), value: data.groups },
    { label: t('analytics.me.upcoming'), value: data.sessions.upcoming },
    { label: t('analytics.me.completed'), value: data.sessions.completed },
    { label: t('analytics.me.attendance'), value: data.attendance.presentRate == null ? '—' : `${data.attendance.presentRate}%` },
  ];
  return (
    <div className="page">
      <PageHeader title={t('analytics.me.title')} subtitle={t('analytics.me.subtitle')} action={<RangeSwitch range={range} onChange={onRange} />} />
      <div className="grid gap-3 sm:grid-cols-3">
        {tiles.map((k) => (
          <div key={k.label} className="card p-4">
            <p className="text-xs text-outline">{k.label}</p>
            <p className="font-heading text-2xl font-bold tabular-nums">{k.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TeacherAnalyticsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<AnalyticsRange>(30);
  // The active workspace decides what this page is: the owner's academy-wide
  // view, or a member's own slice. The server enforces the same split.
  const { data: myAcademies } = useMyAcademies();
  const activeId = useStaffAcademyStore((s) => s.academyId);
  const active = myAcademies?.find((a) => a.academyId === activeId) ?? myAcademies?.find((a) => a.role === 'OWNER');
  const isOwner = !active || active.role === 'OWNER';
  const isCenter = active?.kind === 'CENTER';
  const tabs = TABS.filter((tb) => !(isCenter && tb === 'financial'));
  if (!isOwner) return <MyTeachingView range={range} onRange={setRange} />;
  const { data, isLoading } = useQuery({
    queryKey: ['teacher-analytics'],
    queryFn: async () => (await api.get('/teacher/analytics')).data,
  });

  return (
    <div className="page">
      <PageHeader
        title={t('analytics.title')}
        subtitle={t('analytics.subtitle')}
        action={tab !== 'overview' ? <RangeSwitch range={range} onChange={setRange} /> : undefined}
      />

      <div className="mb-6 flex flex-wrap gap-1 rounded-full bg-surface-container-lowest p-1 shadow-card">
        {tabs.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold transition ${
              tab === tb ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            {t(`analytics.tabs.${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        isLoading || !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
        ) : (
          <>
            <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { icon: 'payments', label: t('analytics.gross'), value: egp(data.grossCents), tint: 'text-primary' },
                { icon: 'group', label: t('analytics.activeStudents'), value: data.activeStudents, tint: 'text-secondary' },
                { icon: 'task_alt', label: t('analytics.completion'), value: `${data.completionRatePct}%`, tint: 'text-primary' },
                { icon: 'quiz', label: t('analytics.quizPass'), value: `${data.quizPassRatePct}%`, tint: 'text-secondary' },
              ].map((k) => (
                <div key={k.icon} className="card flex items-center gap-4">
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

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="card">
                <h3 className="mb-3 font-heading text-lg font-bold">{t('analytics.topLessons')}</h3>
                {!data.topLessons?.length ? (
                  <p className="py-6 text-center text-sm text-outline">{t('analytics.noData')}</p>
                ) : (
                  <ul className="space-y-2">
                    {data.topLessons.map((l: any, i: number) => (
                      <li key={l.lessonId} className="flex items-center gap-3">
                        <span className="grid h-7 w-7 place-items-center rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">{i + 1}</span>
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

            {/* Engagement sits under revenue deliberately: money is why a teacher
                opens this page, and whether their students keep coming back is the
                thing that decides it next month. */}
            <section className="mt-10">
              <h2 className="mb-4 font-heading text-2xl font-extrabold">{t('engagement.title')}</h2>
              <EngagementPanel scope="teacher" />
            </section>
          </>
        )
      )}

      {tab === 'growth' && <GrowthTab range={range} />}
      {tab === 'enrollments' && <EnrollmentsTab />}
      {tab === 'attendance' && <AttendanceTab range={range} />}
      {tab === 'groups' && <GroupsTab />}
      {tab === 'scheduling' && <SchedulingTab range={range} />}
      {tab === 'courses' && <CoursesTab />}
      {tab === 'teachers' && <TeachersTab />}
      {tab === 'financial' && <FinancialTab range={range} />}
    </div>
  );
}

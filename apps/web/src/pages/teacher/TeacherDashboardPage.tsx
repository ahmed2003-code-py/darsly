import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { Badge, PageHeader, Skeleton } from '../../components/ui';
import { Stagger, StaggerItem } from '../../components/motion';

interface Enrollment {
  id: string;
  status: string;
  createdAt: string;
  student: { id: string; user: { fullName: string; avatarUrl?: string | null } };
  course: { id: string; title: string };
  payments?: { amountCents: number }[];
}

/** One row per student, however many courses they bought. */
interface StudentRow {
  studentId: string;
  name: string;
  avatarUrl?: string | null;
  /** Their most recent enrolment — what the row's date and status describe. */
  latest: Enrollment;
  courseCount: number;
  paidCents: number;
  /** True while any of their enrolments is still awaiting approval. */
  awaiting: boolean;
}

/**
 * Teacher home: four figures worth acting on, then who enrolled and what they
 * enrolled in.
 *
 * The enrolment feed is grouped by student, not listed row per enrolment. A
 * teacher whose students buy three courses each used to read their own name
 * list as six strangers — the repetition carried no information and pushed the
 * actual variety (which courses, how recently) off the bottom.
 */
export default function TeacherDashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const { data: courses } = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
  });
  const { data: enrollments, isLoading } = useQuery<Enrollment[]>({
    queryKey: ['teacher-enrollments', 'ALL'],
    queryFn: async () => (await api.get('/teacher/enrollments')).data,
  });
  // Revenue is ledger-authoritative (same source as the wallet), not a naive
  // sum of enrollment payments — so the dashboard matches /teacher/wallet.
  const { data: wallet } = useQuery({
    queryKey: ['teacher-wallet'],
    queryFn: async () => (await api.get('/teacher/wallet')).data,
  });

  const totalCourses = courses?.length ?? 0;
  const published = courses?.filter((c: any) => c.status === 'PUBLISHED').length ?? 0;
  const drafts = totalCourses - published;
  const activeEnrollments = enrollments?.filter((e) => e.status === 'ACTIVE') ?? [];
  const pending = enrollments?.filter((e) => e.status === 'PENDING_APPROVAL').length ?? 0;
  const revenue = wallet?.netCents ?? 0;

  // People, not enrolments. This card said "active students" while counting
  // rows, so one student on three courses was reported as three students —
  // the single number a teacher is most likely to quote about their academy.
  const activeStudents = new Set(activeEnrollments.map((e) => e.student.id)).size;

  /** Students in order of their most recent enrolment. */
  const studentRows = useMemo<StudentRow[]>(() => {
    if (!enrollments?.length) return [];
    const byStudent = new Map<string, StudentRow>();
    // The API already sorts newest-first, so the first sighting of a student is
    // their latest enrolment and every later one only adds to their totals.
    for (const e of enrollments) {
      const existing = byStudent.get(e.student.id);
      const paid = e.payments?.[0]?.amountCents ?? 0;
      if (!existing) {
        byStudent.set(e.student.id, {
          studentId: e.student.id,
          name: e.student.user.fullName,
          avatarUrl: e.student.user.avatarUrl,
          latest: e,
          courseCount: 1,
          paidCents: paid,
          awaiting: e.status === 'PENDING_APPROVAL',
        });
      } else {
        existing.courseCount += 1;
        existing.paidCents += paid;
        existing.awaiting ||= e.status === 'PENDING_APPROVAL';
      }
    }
    return [...byStudent.values()];
  }, [enrollments]);

  /** Courses ranked by how many students are actually studying them. */
  const topCourses = useMemo(() => {
    const counts = new Map<string, { title: string; students: Set<string> }>();
    for (const e of activeEnrollments) {
      const row = counts.get(e.course.id) ?? { title: e.course.title, students: new Set<string>() };
      row.students.add(e.student.id);
      counts.set(e.course.id, row);
    }
    const ranked = [...counts.entries()]
      .map(([id, r]) => ({ id, title: r.title, count: r.students.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const max = ranked[0]?.count ?? 1;
    return ranked.map((r) => ({ ...r, share: Math.round((r.count / max) * 100) }));
  }, [activeEnrollments]);

  const stats = [
    {
      icon: 'menu_book',
      label: t('teacher.statCourses'),
      value: published,
      hint: drafts > 0 ? t('teacher.statCoursesDrafts', { count: drafts }) : t('teacher.statCoursesAll'),
      to: '/teacher/courses',
      urgent: false,
    },
    {
      icon: 'groups',
      label: t('teacher.statStudents'),
      value: activeStudents,
      // Two numbers that used to be conflated, now both visible.
      hint: t('teacher.statStudentsEnrollments', { count: activeEnrollments.length }),
      to: '/teacher/students',
      urgent: false,
    },
    {
      icon: 'pending_actions',
      label: t('teacher.statPending'),
      value: pending,
      hint: pending > 0 ? t('teacher.statPendingAction') : t('teacher.statPendingClear'),
      to: '/teacher/students',
      // The only card that can ask for something. It earns emphasis only when
      // there is actually something waiting — a permanent alert colour on a
      // zero teaches people to ignore it.
      urgent: pending > 0,
    },
    {
      icon: 'payments',
      label: t('teacher.statRevenue'),
      value: egp(revenue),
      hint: t('teacher.statRevenueNet'),
      to: '/teacher/wallet',
      urgent: false,
    },
  ];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title={t('teacher.overviewTitle')}
        subtitle={`${t('dashboard.welcome', { name: user?.fullName })} — ${t('teacher.overviewSubtitle')}`}
        action={
          <div className="flex flex-wrap gap-2">
            <Link to="/academy/studio" className="btn-secondary">
              <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
              {t('teacher.academyStudio')}
            </Link>
            <Link to="/teacher/courses" className="btn-primary">
              <span className="material-symbols-outlined">add</span>
              {t('teacher.newCourse')}
            </Link>
          </div>
        }
      />

      <Stagger className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StaggerItem key={s.icon} className="h-full">
            <Link
              to={s.to}
              className={`card card-hover group flex h-full flex-col justify-between gap-5 p-5 ${
                s.urgent ? 'border-amber-500/40 bg-amber-500/[0.06]' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <span
                  className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
                    s.urgent ? 'bg-amber-500/15 text-amber-600' : 'bg-primary-fixed text-primary'
                  }`}
                >
                  <span className="material-symbols-outlined text-[24px]">{s.icon}</span>
                </span>
                {/* Direction-neutral on purpose: a chevron would point the
                    wrong way in one of the two languages the app ships in. */}
                <span className="material-symbols-outlined text-[18px] text-outline/40 transition-colors group-hover:text-primary rtl:-scale-x-100">
                  arrow_outward
                </span>
              </div>
              <div className="min-w-0">
                <p className="font-heading text-[2rem] font-bold leading-none tabular-nums tracking-tight">
                  {s.value}
                </p>
                <p className="mt-2 truncate text-sm font-semibold text-on-surface-variant">{s.label}</p>
                <p className="mt-0.5 truncate text-xs text-outline">{s.hint}</p>
              </div>
            </Link>
          </StaggerItem>
        ))}
      </Stagger>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* ── Who enrolled ─────────────────────────────────────────────── */}
        <section className="card">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h2 className="font-heading text-xl font-bold">{t('teacher.latestEnrollments')}</h2>
            <Link to="/teacher/students" className="text-sm font-bold text-primary hover:underline">
              {t('teacher.viewAll')}
            </Link>
          </div>
          <p className="mb-5 text-sm text-outline">{t('teacher.latestEnrollmentsHint')}</p>

          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-11 w-11 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : !studentRows.length ? (
            <EmptyNote icon="person_add" text={t('teacher.noEnrollments')} />
          ) : (
            <ul className="divide-y divide-outline-variant/40">
              {studentRows.slice(0, 6).map((s) => (
                <li key={s.studentId} className="flex items-center gap-4 py-3.5">
                  {s.avatarUrl ? (
                    <img
                      src={s.avatarUrl}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                      {s.name?.trim()?.charAt(0)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {/* <bdi> isolates the run: an Arabic course title inside an
                        English line (or the reverse — both happen here) drags
                        the trailing counter to the wrong end without it. */}
                    <p className="truncate font-bold">
                      <bdi>{s.name}</bdi>
                    </p>
                    <p className="truncate text-sm text-on-surface-variant">
                      <bdi>{s.latest.course.title}</bdi>
                      {s.courseCount > 1 && (
                        <span className="text-outline">
                          {' · '}
                          <bdi>{t('teacher.plusMoreCourses', { count: s.courseCount - 1 })}</bdi>
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 text-end">
                    <Badge tone={s.awaiting ? 'warn' : s.latest.status === 'ACTIVE' ? 'teal' : 'neutral'}>
                      {t(`myCourses.status.${s.awaiting ? 'PENDING_APPROVAL' : s.latest.status}`)}
                    </Badge>
                    <p className="mt-1 text-xs text-outline">
                      {dateShort(s.latest.createdAt)}
                      {s.paidCents > 0 && ` · ${egp(s.paidCents)}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── What they're studying ────────────────────────────────────── */}
        <section className="card">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h2 className="font-heading text-xl font-bold">{t('teacher.topCourses')}</h2>
            <Link to="/teacher/courses" className="text-sm font-bold text-primary hover:underline">
              {t('teacher.viewAll')}
            </Link>
          </div>
          <p className="mb-5 text-sm text-outline">{t('teacher.topCoursesHint')}</p>

          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-1.5 w-full rounded-full" />
                </div>
              ))}
            </div>
          ) : !topCourses.length ? (
            <EmptyNote icon="insights" text={t('teacher.noCourseActivity')} />
          ) : (
            <ul className="space-y-4">
              {topCourses.map((c) => (
                <li key={c.id}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-semibold">
                      <bdi>{c.title}</bdi>
                    </span>
                    <span className="shrink-0 font-heading text-sm font-bold tabular-nums text-primary">
                      {c.count}
                    </span>
                  </div>
                  {/* Relative to the best-performing course, not to a total —
                      the question is which course is carrying the academy. */}
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${c.share}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {drafts > 0 && (
            <Link
              to="/teacher/courses"
              className="mt-6 flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-3 transition-colors hover:border-primary/40"
            >
              <span className="material-symbols-outlined text-[20px] text-outline">edit_note</span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{t('teacher.draftsWaiting', { count: drafts })}</span>
                <span className="block truncate text-xs text-outline">{t('teacher.draftsHint')}</span>
              </span>
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyNote({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <span className="material-symbols-outlined text-[32px] text-outline/50">{icon}</span>
      <p className="text-sm text-outline">{text}</p>
    </div>
  );
}

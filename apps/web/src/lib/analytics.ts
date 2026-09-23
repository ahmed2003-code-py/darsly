import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Phase 6: academy + platform analytics hooks. Ranges match the platform
 *  convention already used by admin growth/revenue trends. */
export type AnalyticsRange = 7 | 30 | 90;

export interface StudentsOverview {
  rangeDays: number;
  totalEnrolledStudents: number;
  activeStudents: number;
  newStudents: number;
  returning: { thisWeek: number; lastWeek: number; returned: number; pct: number };
  inactiveStudents: number;
  inactivityThresholdDays: number;
}

export interface GrowthPoint {
  date: string;
  newStudents: number;
  newEnrollments: number;
  activatedEnrollments: number;
  courseActivity: number;
}

export interface EnrollmentBreakdown {
  total: number;
  byStatus: {
    active: number;
    pendingPayment: number;
    pendingApproval: number;
    rejected: number;
    revoked: number;
    expired: number;
  };
  activeBySource: { automatic: number; manual: number; demo: number };
}

export interface AttendanceStats {
  rangeDays: number;
  counts: { present: number; absent: number; late: number; excused: number };
  attendanceRatePct: number | null;
  trend: { date: string; present: number; total: number; ratePct: number | null }[];
  byGroup: {
    groupId: string;
    name: string;
    present: number;
    total: number;
    ratePct: number | null;
  }[];
  atRisk: {
    studentId: string;
    fullName: string;
    groupId: string;
    groupName: string;
    streak: number;
  }[];
}

export interface GroupAnalyticsRow {
  id: string;
  name: string;
  status: string;
  studentsCount: number;
  staff: { role: string; name: string }[];
  attendanceRatePct: number | null;
  sessionsCompleted: number;
  sessionsCancelled: number;
  sessionsUpcoming: number;
}

export interface SchedulingOverview {
  rangeDays: number;
  total: number;
  completed: number;
  cancelled: number;
  scheduledInRange: number;
  upcoming: number;
  roomUsage: { roomId: string; name: string; sessions: number; scheduledMinutes: number }[];
  teacherLoad: { userId: string; fullName: string; sessions: number }[];
  groupLoad: { groupId: string; name: string; sessions: number }[];
}

export interface CourseAnalyticsRow {
  courseId: string;
  title: string;
  status: string;
  priceCents: number;
  totalEnrollments: number;
  activeStudents: number;
  avgProgressPct: number;
  quizPassRatePct: number | null;
  revenueNetCents: number;
  paidTransactions: number;
  automaticEnrollments: number;
  manualEnrollments: number;
  demoEnrollments: number;
}

export interface StaffAnalyticsRow {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
  groupsAssigned: number;
  sessionsRun: number;
  attendanceRatePct: number | null;
}

export interface FinancialOverview {
  rangeDays: number;
  lifetimeNetCents: number;
  netRevenueTrend: { date: string; netCents: number }[];
  paidTransactions: number;
  pendingPayments: number;
  rejectedPayments: number;
  revenueByCourse: { courseId: string; title: string; netCents: number; transactions: number }[];
}

function useAcademyAnalytics<T>(path: string, range?: AnalyticsRange) {
  return useQuery<T>({
    queryKey: ['academy-analytics', path, range],
    queryFn: async () =>
      (await api.get(`/teacher/analytics/${path}`, { params: range ? { range } : undefined })).data,
  });
}

export const useStudentsOverview = (range: AnalyticsRange) =>
  useAcademyAnalytics<StudentsOverview>('students', range);
export const useGrowth = (range: AnalyticsRange) =>
  useAcademyAnalytics<GrowthPoint[]>('growth', range);
export const useEnrollmentBreakdown = () => useAcademyAnalytics<EnrollmentBreakdown>('enrollments');
export const useAttendanceStats = (range: AnalyticsRange) =>
  useAcademyAnalytics<AttendanceStats>('attendance', range);
export const useGroupsAnalytics = () =>
  useAcademyAnalytics<{ total: number; groups: GroupAnalyticsRow[] }>('groups');
export const useSchedulingOverview = (range: AnalyticsRange) =>
  useAcademyAnalytics<SchedulingOverview>('scheduling', range);
export const useCoursesAnalytics = () => useAcademyAnalytics<CourseAnalyticsRow[]>('courses');
export const useStaffAnalytics = () => useAcademyAnalytics<StaffAnalyticsRow[]>('teachers');
export const useFinancialOverview = (range: AnalyticsRange) =>
  useAcademyAnalytics<FinancialOverview>('financial', range);

// ── Platform (admin) additions ──────────────────────────────────────────

export interface PlatformAttendance {
  rangeDays: number;
  counts: { present: number; absent: number; late: number; excused: number };
  attendanceRatePct: number | null;
  trend: { date: string; present: number; total: number; ratePct: number | null }[];
}

export interface PlatformFinancial {
  rangeDays: number;
  grossCents: number;
  commissionCents: number;
  paymentConversion: {
    paid: number;
    pending: number;
    rejected: number;
    convertedPct: number | null;
  };
}

export interface ActiveAcademyRate {
  rangeDays: number;
  totalActiveAcademies: number;
  academiesWithRecentEnrollment: number;
  ratePct: number | null;
}

export function usePlatformAttendance(range: AnalyticsRange) {
  return useQuery<PlatformAttendance>({
    queryKey: ['admin-attendance', range],
    queryFn: async () => (await api.get('/admin/analytics/attendance', { params: { range } })).data,
  });
}

export function usePlatformFinancial(range: AnalyticsRange) {
  return useQuery<PlatformFinancial>({
    queryKey: ['admin-financial', range],
    queryFn: async () => (await api.get('/admin/analytics/financial', { params: { range } })).data,
  });
}

export function useActiveAcademyRate(range: AnalyticsRange) {
  return useQuery<ActiveAcademyRate>({
    queryKey: ['admin-active-academies', range],
    queryFn: async () =>
      (await api.get('/admin/analytics/active-academies', { params: { range } })).data,
  });
}

// ── Center operations (Phase 6) ──────────────────────────────────────────────

export interface CenterOverview {
  academy: { kind: 'PERSONAL' | 'CENTER'; name: string } | null;
  teachers: number;
  students: number;
  courses: { total: number; published: number };
  groups: number;
  sessions: {
    upcoming7d: number;
    upcomingPhysical: number;
    upcomingLive: number;
    completed30d: number;
  };
  attendance: { records30d: number; presentRate: number | null };
  subjectsActive: number | null;
  recentActivity: {
    id: string;
    action: string;
    entity: string;
    entityId: string | null;
    at: string;
    by: string | null;
  }[];
}
export const useCenterOverview = () => useAcademyAnalytics<CenterOverview>('center');

export interface MyTeaching {
  academyId: string;
  courses: number;
  activeEnrollments: number;
  groups: number;
  sessions: { upcoming: number; upcomingPhysical: number; upcomingLive: number; completed: number };
  attendance: { records: number; presentRate: number | null };
}
export const useMyTeaching = (range: AnalyticsRange) =>
  useAcademyAnalytics<MyTeaching>('me', range);

// ── Phase 8: Center activity trail (owner-only) ─────────────────────────────

export interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  createdAt: string;
  actor: { fullName: string; role: string } | null;
  meta: Record<string, unknown> | null;
}
interface ActivityPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
}
/** Cursor-paginated — the Center's own audit trail, one page (30 rows) at a time. */
export function useCenterActivity() {
  return useInfiniteQuery<ActivityPage>({
    queryKey: ['academy-analytics', 'activity'],
    queryFn: async ({ pageParam }) =>
      (
        await api.get('/teacher/analytics/activity', {
          params: pageParam ? { cursor: pageParam } : undefined,
        })
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

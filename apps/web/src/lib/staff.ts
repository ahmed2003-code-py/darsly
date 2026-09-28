import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Role } from '@darsly/shared-types';
import { useAuthStore } from '../stores/auth';
import { useMyAcademies } from './academy';
import { api } from './api';

/**
 * The assistant's workspace. Every call names the academy explicitly
 * (X-Academy-Id) — the one they assist in — rather than relying on the
 * console's selected workspace, so a teacher who also assists somewhere else
 * reads that academy here and their own everywhere else. The header only
 * selects; the server decides from the membership and its courses.
 */

export interface StaffMe {
  academy: { id: string; slug: string; name: string; logoUrl: string | null; kind: string } | null;
  role: string;
  title: string | null;
  directContact: boolean;
  courseScope: 'ALL' | 'SELECTED';
  permissions: string[];
  courses: { id: string; title: string }[];
}

export interface StaffCourse {
  id: string;
  title: string;
  status: string;
  thumbnailUrl: string | null;
  students: number;
}

export interface StaffStudentRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  courses: { id: string; title: string; status: string; since: string }[];
}

export interface StaffStudent extends StaffStudentRow {
  userId: string;
  courses: { id: string; title: string; status: string; since: string; expiresAt: string | null }[];
  can: { progress: boolean; message: boolean };
}

export interface StaffCourseProgress {
  course: { id: string; title: string };
  lessons: { total: number; completed: number };
  percent: number;
  lastActivityAt: string | null;
  quizzes: {
    lessonId: string;
    lessonTitle: string;
    scorePct: number | null;
    passed: boolean | null;
    needsManualGrading: boolean;
    submittedAt: string | null;
  }[];
  assignments: {
    lessonId: string;
    lessonTitle: string;
    maxScore: number;
    score: number | null;
    gradedAt: string | null;
    submittedAt: string;
  }[];
}

export interface StaffPayment {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  method: string | null;
  createdAt: string;
  course: { id: string; title: string } | null;
  student: { id: string; name: string } | null;
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

/**
 * Where this person assists, if anywhere. A STAFF account that owns nothing
 * is an assistant's account and the workspace is its home.
 */
export function useAssistantWorkspace() {
  const role = useAuthStore((s) => s.user?.role);
  const q = useMyAcademies();
  const assisting = (q.data ?? []).filter((a) => a.role === 'ASSISTANT');
  const ownsSomething = (q.data ?? []).some((a) => a.role === 'OWNER');
  return {
    isLoading: q.isLoading,
    academyId: assisting[0]?.academyId,
    academyName: assisting[0]?.name,
    /** The workspace is this account's home, not a side door. */
    isAssistantAccount: role === Role.STAFF && !ownsSomething && assisting.length > 0,
    assists: assisting.length > 0,
  };
}

export function useStaffMe(academyId?: string) {
  return useQuery<StaffMe>({
    queryKey: ['staff-me', academyId],
    queryFn: async () => (await api.get('/staff/me', at(academyId))).data,
    enabled: !!academyId,
    // Access can change under them (a course taken away); keep it fresh.
    staleTime: 30_000,
  });
}

export function useStaffCourses(academyId?: string) {
  return useQuery<StaffCourse[]>({
    queryKey: ['staff-courses', academyId],
    queryFn: async () => (await api.get('/staff/courses', at(academyId))).data,
    enabled: !!academyId,
  });
}

export function useStaffStudents(
  academyId: string | undefined,
  filter: { courseId?: string; q?: string },
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: ['staff-students', academyId, filter.courseId ?? '', filter.q ?? ''],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<{ items: StaffStudentRow[]; nextCursor: string | null }>('/staff/students', {
          ...at(academyId),
          params: {
            ...(filter.courseId ? { courseId: filter.courseId } : {}),
            ...(filter.q ? { q: filter.q } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
      ).data,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!academyId && enabled,
  });
}

export function useStaffStudent(academyId: string | undefined, studentId?: string) {
  return useQuery<StaffStudent>({
    queryKey: ['staff-student', academyId, studentId],
    queryFn: async () => (await api.get(`/staff/students/${studentId}`, at(academyId))).data,
    enabled: !!academyId && !!studentId,
    retry: false,
  });
}

export function useStaffProgress(
  academyId: string | undefined,
  studentId: string | undefined,
  enabled: boolean,
) {
  return useQuery<StaffCourseProgress[]>({
    queryKey: ['staff-progress', academyId, studentId],
    queryFn: async () =>
      (await api.get(`/staff/students/${studentId}/progress`, at(academyId))).data,
    enabled: !!academyId && !!studentId && enabled,
    retry: false,
  });
}

export function useStaffPayments(academyId: string | undefined, status?: string) {
  return useQuery<StaffPayment[]>({
    queryKey: ['staff-payments', academyId, status ?? ''],
    queryFn: async () =>
      (await api.get('/staff/payments', { ...at(academyId), params: status ? { status } : {} }))
        .data,
    enabled: !!academyId,
    retry: false,
  });
}

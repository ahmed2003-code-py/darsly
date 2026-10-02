import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuardianRelationship } from '@darsly/shared-types';
import { useAuthStore } from '../stores/auth';
import { api } from './api';

/**
 * Guardians: the guardian's own view (their children, one per academy link)
 * and staff managing a student's guardians. Every guardian request is
 * authorized by the server through an ACTIVE link; nothing here decides it.
 */

export interface GuardianChild {
  linkId: string;
  relationship: GuardianRelationship;
  academy: { id: string; name: string; logoUrl: string | null };
  student: { id: string; name: string; avatarUrl: string | null };
}

export interface CourseProgress {
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

export interface AttendanceSummary {
  total: number;
  PRESENT: number;
  ABSENT: number;
  LATE: number;
  EXCUSED: number;
  /** makeup: a visit to another group's class (C2). */
  recent: { date: string; group: string; status: string; makeup?: boolean }[];
}

export interface GuardianOverview {
  linkId: string;
  relationship: GuardianRelationship;
  academy: { id: string; name: string };
  student: { id: string; name: string; avatarUrl: string | null };
  courses: (CourseProgress & {
    enrollment: { status: string; since: string; expiresAt: string | null } | null;
  })[];
  attendance: AttendanceSummary | null;
  live: { title: string; startsAt: string; minutes: number }[];
  /**
   * C5: the child's center fees — only where the academy chose to show
   * guardians (off by default). What is owed and the receipts; nothing internal.
   */
  /**
   * C6: the child's published paper-exam grades — only where the academy chose
   * to show guardians (off by default). Never drafts, notes, reasons or ranks.
   */
  grades?:
    | {
        examId: string;
        title: string;
        examDate: string;
        kind: 'REGULAR' | 'MAKEUP';
        makeupOfExamId: string | null;
        status: 'SCORED' | 'ABSENT' | 'EXCUSED';
        score: number | null;
        maxScore: number;
        pctBps: number | null;
        passed: boolean | null;
      }[]
    | null;
  fees?: {
    currency: string;
    outstandingCents: number;
    overdueCents: number;
    receipts: {
      receiptNumber: string;
      localDate: string;
      amountCents: number;
      currency: string;
      method: string;
      reversed: boolean;
    }[];
  } | null;
  activity: {
    kind: 'QUIZ' | 'ASSIGNMENT' | 'ATTENDANCE' | 'LIVE';
    at: string;
    course: string | null;
    title: string;
    scorePct?: number | null;
    score?: string | null;
    minutes?: number;
  }[];
}

export interface StaffGuardian {
  id: string;
  name: string;
  phone: string | null;
  relationship: GuardianRelationship;
  status: 'ACTIVE' | 'REVOKED';
  /** INVITED until one of their links was really opened (CONNECTED); REVOKED when removed. */
  state?: 'INVITED' | 'CONNECTED' | 'REVOKED';
  createdAt: string;
  revokedAt: string | null;
  link: { expiresAt: string; lastUsedAt: string | null; issuedAt: string; expired: boolean } | null;
}

/**
 * The URL a guardian opens. The token rides in the fragment: browsers never
 * send it to a server, so it stays out of access logs and referrers.
 */
export function guardianAccessUrl(token: string): string {
  return `${window.location.origin}/g#${token}`;
}

export function useGuardianChildren() {
  const role = useAuthStore((s) => s.user?.role);
  return useQuery<GuardianChild[]>({
    queryKey: ['guardian-children'],
    queryFn: async () => (await api.get('/guardian/children')).data,
    enabled: role === 'GUARDIAN',
  });
}

export function useGuardianOverview(linkId?: string) {
  return useQuery<GuardianOverview>({
    queryKey: ['guardian-overview', linkId],
    queryFn: async () => (await api.get(`/guardian/children/${linkId}`)).data,
    enabled: !!linkId,
    retry: false,
  });
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function useStudentGuardians(academyId?: string, studentId?: string, enabled = true) {
  return useQuery<StaffGuardian[]>({
    queryKey: ['student-guardians', academyId, studentId],
    queryFn: async () =>
      (await api.get(`/staff/students/${studentId}/guardians`, at(academyId))).data,
    enabled: !!academyId && !!studentId && enabled,
    retry: false,
  });
}

export function useGuardianActions(academyId?: string, studentId?: string) {
  const qc = useQueryClient();
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ['student-guardians', academyId, studentId] });
  return {
    add: useMutation({
      mutationFn: async (body: {
        name: string;
        phone: string;
        relationship: GuardianRelationship;
      }) =>
        (
          await api.post<{ id: string; token: string; expiresInDays: number }>(
            `/staff/students/${studentId}/guardians`,
            body,
            at(academyId),
          )
        ).data,
      onSuccess: refresh,
    }),
    rotate: useMutation({
      mutationFn: async (linkId: string) =>
        (
          await api.post<{ id: string; token: string; expiresInDays: number }>(
            `/staff/guardian-links/${linkId}/token`,
            {},
            at(academyId),
          )
        ).data,
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: async (linkId: string) =>
        (await api.delete(`/staff/guardian-links/${linkId}`, at(academyId))).data,
      onSuccess: refresh,
    }),
  };
}

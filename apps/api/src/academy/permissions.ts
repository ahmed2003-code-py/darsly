import { BadRequestException } from '@nestjs/common';
import { AcademyRole } from '@prisma/client';
import { Role } from '@darsly/shared-types';

/**
 * Named capabilities — the extensibility seam for authorization. New roles or
 * fine-grained grants become data (role defaults + per-membership overrides),
 * never a schema change. A member's effective set = role defaults ∪ overrides.
 */
export const CAPABILITIES = [
  'academy.manage', // settings, branding, domains, fee plan
  'member.manage', // invite/remove staff, change roles
  'course.write', // create/edit courses
  'content.write', // units, lessons, video uploads
  'assessment.author', // create quizzes/assignments
  'assessment.grade', // grade attempts/submissions
  'student.manage', // approve/revoke/manage students
  'payment.verify', // verify manual payments
  'chat.moderate',
  'live.manage', // schedule/manage live sessions
  'analytics.read',
  'wallet.read',
  'wallet.withdraw',
  'group.manage', // create/edit/archive groups, assign staff, manage membership — scoped further by GroupAssignment (see AcademyOpsAccessService)
  'attendance.mark', // mark/update attendance — same per-group scoping
  'schedule.manage', // create/reschedule/cancel group sessions — same per-group scoping as group.manage
  'room.manage', // create/edit/archive physical rooms — OWNER only, not granted to TEACHER/ASSISTANT below
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const OWNER_ALL: Capability[] = [...CAPABILITIES];

/** Default capabilities per in-academy role. */
export const ROLE_PERMISSIONS: Record<AcademyRole, Capability[]> = {
  OWNER: OWNER_ALL,
  TEACHER: [
    'course.write',
    'content.write',
    'assessment.author',
    'assessment.grade',
    'student.manage',
    'payment.verify',
    'chat.moderate',
    'live.manage',
    'analytics.read',
    'wallet.read',
    'group.manage',
    'attendance.mark',
    'schedule.manage',
  ],
  ASSISTANT: [
    'assessment.author',
    'assessment.grade',
    'student.manage',
    'chat.moderate',
    'live.manage',
    'group.manage',
    'attendance.mark',
    'schedule.manage',
  ],
  STUDENT: [], // students act through enrollments, not academy-management grants
};

function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

/**
 * Capabilities that only the OWNER role may ever hold. A per-membership
 * override can widen a TEACHER/ASSISTANT within their tier, but never up to
 * organisation authority — otherwise a single JSON write would make anyone an
 * owner in all but name.
 */
export const OWNER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  'academy.manage',
  'member.manage',
  'wallet.withdraw',
  'room.manage',
]);

/** Effective capability set = role defaults ∪ valid membership overrides (ceilinged). */
export function permissionsFor(role: AcademyRole, overrides: unknown = []): Set<Capability> {
  const set = new Set<Capability>(ROLE_PERMISSIONS[role] ?? []);
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (typeof o !== 'string' || !isCapability(o)) continue;
      if (role !== 'OWNER' && OWNER_ONLY.has(o)) continue;
      set.add(o);
    }
  }
  return set;
}

/**
 * Who may hold which membership role — the single source of truth, used both
 * by direct invite (addMember) and invitation-link redemption. OWNER is never
 * granted through either path. TEACHER/ASSISTANT carry content-authoring
 * capabilities that are meaningless without an approved teacher identity, and
 * a learner account must never become staff.
 */
export function assertStaffEligible(
  user: { role: string; isActive: boolean; teacherProfile: { status: string } | null },
  role: AcademyRole,
) {
  if (!user.isActive) throw new BadRequestException({ message: 'This account is disabled', code: 'USER_INACTIVE' });
  if (user.role === Role.STUDENT) {
    throw new BadRequestException({ message: 'A student account cannot hold a staff role', code: 'STUDENT_NOT_STAFF' });
  }
  if (role === 'TEACHER' || role === 'ASSISTANT') {
    if (user.role !== Role.TEACHER || user.teacherProfile?.status !== 'APPROVED') {
      throw new BadRequestException({ message: 'Only an approved teacher can hold this role', code: 'TEACHER_NOT_APPROVED' });
    }
  }
}

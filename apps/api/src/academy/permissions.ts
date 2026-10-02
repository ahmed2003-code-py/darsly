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
  // Phase 7: record/confirm CASH received by the ORGANISATION (a Center's desk).
  // OWNER by default; an owner may grant it to a member (the "cashier") — the
  // money is the organisation's, never tied to one person's identity.
  'payment.collect',
  'chat.moderate',
  'live.manage', // schedule/manage live sessions
  'analytics.read',
  'wallet.read',
  'wallet.withdraw',
  'group.manage', // create/edit/archive groups, assign staff, manage membership — scoped further by GroupAssignment (see AcademyOpsAccessService)
  'attendance.mark', // mark/update attendance — same per-group scoping
  'schedule.manage', // create/reschedule/cancel group sessions — same per-group scoping as group.manage
  'room.manage', // create/edit/archive physical rooms — OWNER only, not granted to TEACHER/ASSISTANT below
  // Phase 1 (assistants). Each one reaches only the member's courses — see
  // StaffScopeService, which every route behind these goes through.
  'student.view', // see the students of my courses
  'progress.view', // see their lessons, quiz and assignment results
  'message.reply', // talk with the students of my courses, as myself
  // Phase 2 (shared inbox). inbox: the academy's TEAM conversations with
  // students of my courses. oversee: manage anyone's assignment, and resolve
  // any of them — the owner's by default, never an assistant's.
  'message.inbox',
  'message.oversee',
  // A class group's chat: take part in the chats of groups that are yours
  // (the owner's every group; anyone else's only groups assigned to them).
  'message.group',
  'guardian.manage', // (Guardian phase) link and manage a student's guardians
  'payment.view', // see payments for my courses — read only, never the wallet
  // Center Operations C1 — the academy's student register. Both reach the
  // WHOLE academy (every registered learner, with their contact numbers), so
  // neither is a TEACHER default: a Center teacher keeps seeing the students
  // of their own courses and groups, and the desk is granted these by the owner.
  'student.directory', // look up and export the register: codes, names, phones, guardians
  'student.register', // register, edit, withdraw/reactivate, import, and enrol a register student into a group
  // Center Operations C3 — the reception desk. Both reach every learner of the
  // academy (a scan can be anyone), so neither is a TEACHER default: a Center
  // teacher keeps C2's attendance for their own groups; the owner grants these.
  'desk.checkin', // identify a learner (card, code, register search) and check them into a real class
  'card.manage', // issue, reissue and revoke learners' QR cards
  // Center Operations C4 — the center's OWN fees (never platform money: a
  // Darsly course paid in cash at a Center stays payment.collect). Every one
  // reaches every learner of the academy, so none is a TEACHER default.
  'fees.view', // see a learner's fees, statement, receipts and who owes what
  'fees.collect', // record money received and print its receipt
  'fees.manage', // fee plans, one-time charges, voiding a charge posted by mistake
  'fees.adjust', // discounts and corrections, with a reason
  'fees.reverse', // reverse a collection recorded by mistake
  'fees.report', // the day's collections for everyone, totals, exports
  // Center Operations C5 — student follow-up (academy-wide, not a teacher default).
  'followup.view', // who needs follow-up, cases, contact history and its notes, the timeline
  'followup.manage', // open, assign and close cases; log a contact with a family
  // Center Operations C6 — paper exams and grades. Group-scoped: a member reaches
  // only the groups they are assigned to (the owner reaches all).
  'grades.view', // exams, results, statistics and history of reachable groups
  'grades.manage', // create exams, enter draft grades, publish
  'grades.correct', // correct a published grade (with a reason), void an exam
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
    'student.view',
    'progress.view',
    'message.reply',
    'message.inbox',
    'message.group',
    'guardian.manage',
    'payment.view',
    // C6: their assigned groups' paper exams — never post-publish correction.
    'grades.view',
    'grades.manage',
  ],
  // An assistant holds exactly what the owner granted them, one capability at
  // a time (their membership `permissions`) — never a role default that grows
  // when the platform adds a capability. See ASSISTANT_CEILING.
  ASSISTANT: [],
  STUDENT: [], // students act through enrollments, not academy-management grants
};

/**
 * The most an ASSISTANT can ever be granted. Everything outside it is either
 * the organisation's (OWNER_ONLY), authorship (course/content), or money that
 * moves (collecting, verifying, the wallet): an assistant may be shown
 * payments, never handle them.
 */
export const ASSISTANT_CEILING: ReadonlySet<Capability> = new Set<Capability>([
  'student.view',
  'progress.view',
  'message.reply',
  'message.inbox',
  'message.group',
  'guardian.manage',
  'payment.view',
  'assessment.grade',
  'attendance.mark',
  'group.manage',
  'schedule.manage',
  // The desk (Reception preset). Academy-wide, so ACADEMY_WIDE below takes
  // them off an assistant limited to some courses.
  'student.directory',
  'student.register',
  'desk.checkin',
  'card.manage',
  'fees.view',
  'fees.collect',
  'fees.manage',
  'fees.adjust',
  'fees.reverse',
  'fees.report',
  'followup.view',
  'followup.manage',
  'grades.view',
  'grades.manage',
  'grades.correct',
  // Kept for assistants from before Phase 1 (backfilled with them); the Team
  // screen does not offer them.
  'assessment.author',
  'student.manage',
  'live.manage',
  'chat.moderate',
]);

/**
 * Capabilities whose routes see the WHOLE academy (every student, every live
 * session) rather than a member's courses. Held by a member limited to some
 * courses they would leak the rest, so for such a member they are simply off —
 * one rule here instead of a scope check in routes that have none.
 */
export const ACADEMY_WIDE: ReadonlySet<Capability> = new Set<Capability>([
  'student.manage',
  'live.manage',
  'analytics.read',
  'assessment.author',
  'chat.moderate',
  'student.directory',
  'student.register',
  'desk.checkin',
  'card.manage',
  'fees.view',
  'fees.collect',
  'fees.manage',
  'fees.adjust',
  'fees.reverse',
  'fees.report',
  'followup.view',
  'followup.manage',
]);

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

/**
 * Effective capability set = role defaults ∪ valid membership overrides
 * (ceilinged). For an ASSISTANT the overrides ARE the grant, cut to
 * ASSISTANT_CEILING, and — when they work on only some courses — with the
 * academy-wide capabilities taken off.
 */
export function permissionsFor(
  role: AcademyRole,
  overrides: unknown = [],
  courseScope: 'ALL' | 'SELECTED' = 'ALL',
): Set<Capability> {
  const set = new Set<Capability>(ROLE_PERMISSIONS[role] ?? []);
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (typeof o !== 'string' || !isCapability(o)) continue;
      if (role !== 'OWNER' && OWNER_ONLY.has(o)) continue;
      if (role === 'ASSISTANT' && !ASSISTANT_CEILING.has(o)) continue;
      set.add(o);
    }
  }
  if (role === 'ASSISTANT' && courseScope === 'SELECTED') {
    for (const c of ACADEMY_WIDE) set.delete(c);
  }
  return set;
}

/**
 * A grant as the Team screen sends it, reduced to what may be stored: known
 * capabilities inside the ceiling, each once, in a stable order. Anything
 * else is refused rather than silently dropped — a teacher who ticked a box
 * must not be told it saved when it did not.
 */
export function assistantGrant(requested: string[]): Capability[] {
  const bad = requested.filter((c) => !isCapability(c) || !ASSISTANT_CEILING.has(c));
  if (bad.length) {
    throw new BadRequestException({
      message: `An assistant cannot be given: ${bad.join(', ')}`,
      code: 'CAPABILITY_NOT_GRANTABLE',
    });
  }
  return CAPABILITIES.filter((c) => requested.includes(c));
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
  if (!user.isActive)
    throw new BadRequestException({ message: 'This account is disabled', code: 'USER_INACTIVE' });
  if (user.role === Role.STUDENT) {
    throw new BadRequestException({
      message: 'A student account cannot hold a staff role',
      code: 'STUDENT_NOT_STAFF',
    });
  }
  // An assistant needs no teacher identity: they act as themselves (a STAFF
  // account, or a teacher lending a hand in someone else's academy).
  if (role === 'ASSISTANT') {
    if (user.role === Role.STAFF) return;
    if (user.role === Role.TEACHER && user.teacherProfile?.status === 'APPROVED') return;
    throw new BadRequestException({
      message: 'This account cannot be an assistant',
      code: 'ASSISTANT_NOT_ELIGIBLE',
    });
  }
  if (role === 'TEACHER') {
    if (user.role !== Role.TEACHER || user.teacherProfile?.status !== 'APPROVED') {
      throw new BadRequestException({
        message: 'Only an approved teacher can hold this role',
        code: 'TEACHER_NOT_APPROVED',
      });
    }
  }
}

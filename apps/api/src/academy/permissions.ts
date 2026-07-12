import { AcademyRole } from '@prisma/client';

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
  ],
  ASSISTANT: [
    'assessment.author',
    'assessment.grade',
    'student.manage',
    'chat.moderate',
    'live.manage',
  ],
  STUDENT: [], // students act through enrollments, not academy-management grants
};

function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

/** Effective capability set = role defaults ∪ valid membership overrides. */
export function permissionsFor(role: AcademyRole, overrides: unknown = []): Set<Capability> {
  const set = new Set<Capability>(ROLE_PERMISSIONS[role] ?? []);
  if (Array.isArray(overrides)) {
    for (const o of overrides) if (typeof o === 'string' && isCapability(o)) set.add(o);
  }
  return set;
}

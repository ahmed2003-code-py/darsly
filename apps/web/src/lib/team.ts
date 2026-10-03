import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Assistants: what the owner's Team screen reads and writes. What is stored
 * is always the explicit grant — capabilities, courses, contact — never the
 * preset it was started from (presets live only in this file, as shortcuts).
 */

export type AssistantCapability =
  | 'student.view'
  | 'progress.view'
  | 'message.reply'
  | 'message.inbox'
  | 'message.group'
  | 'assessment.grade'
  | 'attendance.mark'
  | 'group.manage'
  | 'schedule.manage'
  | 'payment.view'
  | 'guardian.manage'
  | 'student.directory'
  | 'student.register'
  | 'desk.checkin'
  | 'card.manage'
  | 'fees.view'
  | 'fees.collect'
  | 'fees.manage'
  | 'fees.adjust'
  | 'fees.reverse'
  | 'fees.report'
  | 'followup.view'
  | 'followup.manage'
  | 'grades.view'
  | 'grades.manage'
  | 'grades.correct'
  | 'daily.view'
  | 'daily.close';

export interface AssistantGrant {
  title: string;
  permissions: string[];
  courseScope: 'ALL' | 'SELECTED';
  courseIds: string[];
  directContact: boolean;
}

export interface TeamAssistant {
  membershipId: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  title: string | null;
  permissions: string[];
  courseScope: 'ALL' | 'SELECTED';
  courses: { id: string; title: string }[];
  directContact: boolean;
  joinedAt: string | null;
}

export interface TeamCourse {
  id: string;
  title: string;
  status: string;
  thumbnailUrl: string | null;
}

export interface AssistantLink {
  id: string;
  role: 'TEACHER' | 'ASSISTANT';
  status: 'PENDING' | 'USED' | 'REVOKED' | 'DECLINED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
  grant: AssistantGrant | null;
}

/** The capabilities the Team screen offers, in the order it shows them, grouped. */
export const CAPABILITY_GROUPS: { key: string; caps: AssistantCapability[] }[] = [
  { key: 'students', caps: ['student.view', 'progress.view'] },
  { key: 'messages', caps: ['message.reply', 'message.inbox', 'message.group'] },
  {
    key: 'teaching',
    caps: ['assessment.grade', 'attendance.mark', 'group.manage', 'schedule.manage'],
  },
  { key: 'payments', caps: ['payment.view'] },
  { key: 'guardians', caps: ['guardian.manage'] },
  // The student register (Center Operations C1) — offered only where it is switched on.
  { key: 'register', caps: ['student.directory', 'student.register'] },
  // The reception desk (C3) — offered only where it is switched on.
  { key: 'desk', caps: ['desk.checkin', 'card.manage'] },
  // The center's own fees (C4) — offered only where they are switched on.
  // Never platform money: that is payment.view / the wallet, above.
  {
    key: 'fees',
    caps: [
      'fees.view',
      'fees.collect',
      'fees.manage',
      'fees.adjust',
      'fees.reverse',
      'fees.report',
    ],
  },
  // Student follow-up (C5) — offered only where it is switched on.
  { key: 'followup', caps: ['followup.view', 'followup.manage'] },
  // Paper exams and grades (C6) — offered only where they are switched on.
  // Group-scoped: an assistant grades only the groups they are assigned to.
  { key: 'grades', caps: ['grades.view', 'grades.manage', 'grades.correct'] },
  // The day's operations and its close (C7) — offered only where they are switched on.
  { key: 'daily', caps: ['daily.view', 'daily.close'] },
];
export const OFFERED = new Set<string>(CAPABILITY_GROUPS.flatMap((g) => g.caps));

export type PresetKey =
  'support' | 'academic' | 'operations' | 'reception' | 'frontDesk' | 'custom';

const SUPPORT: AssistantCapability[] = [
  'student.view',
  'progress.view',
  'message.reply',
  'message.inbox',
  'guardian.manage',
];
export const PRESETS: Record<
  Exclude<PresetKey, 'custom'>,
  { permissions: AssistantCapability[]; directContact: boolean }
> = {
  support: { permissions: SUPPORT, directContact: true },
  academic: {
    permissions: [
      ...SUPPORT,
      'assessment.grade',
      'attendance.mark',
      'group.manage',
      'message.group',
    ],
    directContact: false,
  },
  operations: {
    permissions: [
      'student.view',
      'message.reply',
      'schedule.manage',
      'attendance.mark',
      'payment.view',
    ],
    directContact: false,
  },
  // The desk: find, register and enrol students — and nothing about money,
  // courses or settings. Needs every course in scope (the register is the
  // whole academy's; a course-limited assistant is never granted it).
  reception: {
    permissions: ['student.view', 'student.directory', 'student.register'],
    directContact: false,
  },
  // The reception desk (C3): the register plus checking learners in and
  // their QR cards. Nothing about courses, settings or teaching; where C4 is
  // on, the fees a desk needs (its hint says so: team.preset.frontDesk.hintFees).
  frontDesk: {
    permissions: [
      'student.view',
      'student.directory',
      'student.register',
      'desk.checkin',
      'card.manage',
      // C4, where fees are on: see what is owed, take money, print the
      // receipt — never plans, discounts, reversals or the center's totals.
      'fees.view',
      'fees.collect',
      // C5: follow up with families — see who needs it, call or open
      // WhatsApp, log what happened, invite a register contact as a guardian.
      'guardian.manage',
      'followup.view',
      'followup.manage',
    ],
    directContact: false,
  },
};

/** Capability groups and presets that only mean something where the student register is on. */
export const REGISTRY_ONLY_GROUPS = new Set(['register']);
export const REGISTRY_ONLY_PRESETS = new Set<PresetKey>(['reception']);
/** …and the ones that only mean something where the desk (C3) is on. */
export const DESK_ONLY_GROUPS = new Set(['desk']);
export const DESK_ONLY_PRESETS = new Set<PresetKey>(['frontDesk']);
/** …and the center's fees (C4). */
export const FEES_ONLY_GROUPS = new Set(['fees']);
/** …and student follow-up (C5). */
export const FOLLOWUP_ONLY_GROUPS = new Set(['followup']);
/** …and paper exams (C6). */
export const GRADES_ONLY_GROUPS = new Set(['grades']);
/** …and the day's operations (C7). */
export const DAILY_ONLY_GROUPS = new Set(['daily']);
/** Groups that reach the whole academy, so never granted course by course. */
export const ACADEMY_WIDE_GROUPS = new Set(['register', 'desk', 'fees', 'followup', 'daily']);

/** Which preset a grant matches exactly, if any — so editing shows where it came from. */
export function presetOf(
  permissions: string[],
  directContact: boolean,
  /** Capabilities of groups not offered here (a feature that is off): ignored on both sides. */
  hidden: ReadonlySet<string> = new Set(),
): PresetKey {
  const shown = permissions
    .filter((p) => OFFERED.has(p) && !hidden.has(p))
    .sort()
    .join();
  for (const [key, p] of Object.entries(PRESETS)) {
    const want = p.permissions.filter((c) => !hidden.has(c));
    if ([...want].sort().join() === shown && p.directContact === directContact) {
      return key as PresetKey;
    }
  }
  return 'custom';
}

const key = (slug?: string) => ['team', slug];

export function useTeam(slug?: string) {
  return useQuery<TeamAssistant[]>({
    queryKey: key(slug),
    queryFn: async () => (await api.get(`/academies/${slug}/team`)).data,
    enabled: !!slug,
  });
}

export function useTeamCourses(slug?: string) {
  return useQuery<TeamCourse[]>({
    queryKey: ['team-courses', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/team/courses`)).data,
    enabled: !!slug,
  });
}

export function useAssistantLinks(slug?: string) {
  return useQuery<AssistantLink[]>({
    queryKey: ['team-links', slug],
    queryFn: async () =>
      ((await api.get(`/academies/${slug}/invitation-links`)).data as AssistantLink[]).filter(
        (l) => l.role === 'ASSISTANT',
      ),
    enabled: !!slug,
  });
}

export function useSaveAssistant(slug?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ membershipId, grant }: { membershipId: string; grant: AssistantGrant }) =>
      (await api.put(`/academies/${slug}/team/${membershipId}`, grant)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: key(slug) }),
  });
}

export function useInviteAssistant(slug?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (grant: AssistantGrant) =>
      (
        await api.post<{ id: string; token: string; expiresAt: string }>(
          `/academies/${slug}/invitation-links`,
          { role: 'ASSISTANT', grant },
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-links', slug] }),
  });
}

export function useRevokeAssistantLink(slug?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/academies/${slug}/invitation-links/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-links', slug] }),
  });
}

/** Suspend, reactivate or remove — the existing member routes. */
export function useMemberStatus(slug?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      membershipId,
      action,
    }: {
      membershipId: string;
      action: 'SUSPENDED' | 'ACTIVE' | 'REMOVE';
    }) =>
      action === 'REMOVE'
        ? (await api.delete(`/academies/${slug}/members/${membershipId}`)).data
        : (await api.patch(`/academies/${slug}/members/${membershipId}`, { status: action })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: key(slug) }),
  });
}

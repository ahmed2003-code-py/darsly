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
  | 'card.manage';

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
  // their QR cards. Still nothing about money, courses, settings or teaching.
  frontDesk: {
    permissions: [
      'student.view',
      'student.directory',
      'student.register',
      'desk.checkin',
      'card.manage',
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
/** Groups that reach the whole academy, so never granted course by course. */
export const ACADEMY_WIDE_GROUPS = new Set(['register', 'desk']);

/** Which preset a grant matches exactly, if any — so editing shows where it came from. */
export function presetOf(permissions: string[], directContact: boolean): PresetKey {
  const shown = permissions
    .filter((p) => OFFERED.has(p))
    .sort()
    .join();
  for (const [key, p] of Object.entries(PRESETS)) {
    if ([...p.permissions].sort().join() === shown && p.directContact === directContact) {
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

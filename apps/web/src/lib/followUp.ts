import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Center Operations C5 — student follow-up and guardian connection.
 *
 * Who needs follow-up is a SIGNAL the server derives on every read from
 * attendance (C2) and fees (C4); C5 itself stores only cases and contacts.
 * Nothing here contacts anyone: a call or a WhatsApp message is opened on the
 * staff member's own phone (tel: / wa.me), and its outcome is then logged.
 */

export type SignalReason = 'ABSENT_TODAY' | 'ABSENT_STREAK' | 'LATE_STREAK' | 'FEES_OVERDUE';
export type CaseReason = SignalReason | 'MANUAL';
export type CaseStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';
export type Channel = 'PHONE_CALL' | 'WHATSAPP' | 'IN_PERSON' | 'APP_MESSAGE' | 'OTHER';
export type Outcome = 'REACHED' | 'NO_ANSWER' | 'WRONG_NUMBER' | 'MESSAGE_SENT' | 'OTHER';
export type Party = 'GUARDIAN_LINK' | 'REGISTER_GUARDIAN' | 'STUDENT' | 'OTHER';
export type GuardianState = 'INVITED' | 'CONNECTED' | 'REVOKED';

export const SIGNAL_REASONS: SignalReason[] = [
  'ABSENT_TODAY',
  'ABSENT_STREAK',
  'LATE_STREAK',
  'FEES_OVERDUE',
];
export const CHANNELS: Channel[] = ['PHONE_CALL', 'WHATSAPP', 'IN_PERSON', 'APP_MESSAGE', 'OTHER'];
export const OUTCOMES: Outcome[] = [
  'REACHED',
  'NO_ANSWER',
  'WRONG_NUMBER',
  'MESSAGE_SENT',
  'OTHER',
];

export interface FollowUpAccess {
  enabled: boolean;
  canView: boolean;
  canManage: boolean;
  canSettings: boolean;
  canGuardians: boolean;
  seesFees: boolean;
}

export interface FollowUpSettings {
  absenceStreak: number;
  lateStreak: number;
  overdueDays: number;
  guardianFeesVisible: boolean;
}

export interface CaseView {
  id: string;
  academyStudentId: string;
  student: { id: string; fullName: string; code: string } | null;
  reason: CaseReason;
  signalKey: string | null;
  note: string | null;
  status: CaseStatus;
  assignedTo: { id: string; name: string } | null;
  dueOn: string | null;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
}

export interface SignalRow {
  academyStudentId: string;
  reason: SignalReason;
  signalKey: string;
  groupId: string | null;
  groupName: string | null;
  count: number;
  since: string;
  overdueCents?: number;
  student: { id: string; fullName: string; code: string } | null;
  openCase: { id: string; assignedToUserId: string | null } | null;
  contactedToday: boolean;
  lastContactAt: string | null;
}

export interface SignalsPage {
  today: string;
  timezone: string;
  settings: FollowUpSettings;
  totals: Record<SignalReason, number>;
  total: number;
  page: number;
  pageSize: number;
  items: SignalRow[];
}

export interface ContactView {
  id: string;
  followUpId: string | null;
  party: Party;
  guardianLinkId: string | null;
  channel: Channel;
  outcome: Outcome;
  note: string | null;
  contactedAt: string;
  contactedBy: string;
  student?: { id: string; fullName: string; code: string };
}

export interface StudentFollowUp {
  timezone: string;
  student: { id: string; fullName: string; code: string; status: string };
  parties: {
    guardians: {
      linkId: string;
      name: string;
      phone: string | null;
      relationship: string;
      state: GuardianState;
    }[];
    registerContact: { name: string | null; phone: string; invitedAs: string | null } | null;
    studentPhone: string | null;
  };
  cases: CaseView[];
  contacts: ContactView[];
}

export interface TimelineItem {
  at: string;
  localDate: string;
  kind: string;
  ref: string;
  data: Record<string, unknown>;
}

// ── Contact handoffs (no provider; the staff member's own phone) ─────────

/** Digits of an E.164 number, for tel: and wa.me (nothing else goes in the URL). */
export function phoneDigits(phone: string): string | null {
  const d = phone.replace(/[^\d]/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function telUrl(phone: string): string | null {
  const d = phoneDigits(phone);
  return d ? `tel:+${d}` : null;
}

/**
 * The default WhatsApp opening — privacy-safe by construction: no amount, no
 * attendance detail, no grade, no note, not even the learner's name. Staff
 * continue the conversation themselves once they know who they are talking to.
 */
export const WHATSAPP_TEMPLATE = {
  ar: 'مرحبًا، نرجو التواصل مع السنتر بخصوص متابعة الطالب.',
  en: "Hello, please contact the center regarding the student's follow-up.",
} as const;

export function whatsappUrl(phone: string, lang: string): string | null {
  const d = phoneDigits(phone);
  if (!d) return null;
  const text = lang === 'en' ? WHATSAPP_TEMPLATE.en : WHATSAPP_TEMPLATE.ar;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

// ── Hooks ────────────────────────────────────────────────────────────────

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function useFollowUpAccess(academyId?: string) {
  return useQuery<FollowUpAccess>({
    queryKey: ['fu-access', academyId],
    queryFn: async () => (await api.get('/follow-up/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSignals(
  academyId: string | undefined,
  q: { reason?: SignalReason; notContacted?: boolean; page: number },
  enabled = true,
) {
  return useQuery<SignalsPage>({
    queryKey: ['fu-signals', academyId, q],
    queryFn: async () =>
      (
        await api.get('/follow-up/signals', {
          ...at(academyId),
          params: {
            ...(q.reason ? { reason: q.reason } : {}),
            ...(q.notContacted ? { notContacted: '1' } : {}),
            page: q.page,
          },
        })
      ).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCases(
  academyId: string | undefined,
  q: { status: CaseStatus; mine: boolean; page: number },
  enabled = true,
) {
  return useQuery<{ total: number; page: number; pageSize: number; items: CaseView[] }>({
    queryKey: ['fu-cases', academyId, q],
    queryFn: async () =>
      (
        await api.get('/follow-up/cases', {
          ...at(academyId),
          params: { status: q.status, ...(q.mine ? { mine: '1' } : {}), page: q.page },
        })
      ).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useContactsToday(academyId: string | undefined, page: number, enabled = true) {
  return useQuery<{
    today: string;
    timezone: string;
    total: number;
    page: number;
    pageSize: number;
    items: ContactView[];
  }>({
    queryKey: ['fu-contacts', academyId, page],
    queryFn: async () =>
      (await api.get('/follow-up/contacts/today', { ...at(academyId), params: { page } })).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useStudentFollowUp(
  academyId: string | undefined,
  academyStudentId: string | undefined,
  enabled = true,
) {
  return useQuery<StudentFollowUp>({
    queryKey: ['fu-student', academyId, academyStudentId],
    queryFn: async () =>
      (await api.get(`/follow-up/students/${academyStudentId}`, at(academyId))).data,
    enabled: !!academyId && !!academyStudentId && enabled,
  });
}

export async function fetchTimeline(
  academyId: string,
  academyStudentId: string,
  before?: string,
): Promise<{ timezone: string; fees: boolean; items: TimelineItem[]; nextBefore: string | null }> {
  return (
    await api.get(`/follow-up/students/${academyStudentId}/timeline`, {
      ...at(academyId),
      params: before ? { before } : {},
    })
  ).data;
}

export function useFollowUpSettings(academyId: string | undefined, enabled = true) {
  return useQuery<FollowUpSettings>({
    queryKey: ['fu-settings', academyId],
    queryFn: async () => (await api.get('/follow-up/settings', at(academyId))).data,
    enabled: !!academyId && enabled,
  });
}

export function useFollowUpStaff(academyId: string | undefined, enabled = true) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['fu-staff', academyId],
    queryFn: async () => (await api.get('/follow-up/staff', at(academyId))).data,
    enabled: !!academyId && enabled,
    staleTime: 60_000,
  });
}

/** Everything showing follow-up state refreshes after a write. */
function useFollowUpInvalidate(academyId?: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of [
      'fu-signals',
      'fu-cases',
      'fu-contacts',
      'fu-student',
      'fu-settings',
      'fu-timeline',
    ])
      void qc.invalidateQueries({ queryKey: [k, academyId] });
  };
}

export function useFollowUpActions(academyId: string | undefined) {
  const done = useFollowUpInvalidate(academyId);
  const post = <T>(url: string, body: unknown) =>
    api.post<T>(url, body, at(academyId)).then((r) => r.data);
  return {
    open: useMutation({
      mutationFn: (v: {
        requestKey: string;
        academyStudentId: string;
        reason: CaseReason;
        signalKey?: string;
        note?: string;
        assignedToUserId?: string;
        dueOn?: string;
      }) => post<{ created: boolean; case: CaseView }>('/follow-up/cases', v),
      onSuccess: done,
      // Offline must say so (the dialog does); a retry reuses the same request key.
      networkMode: 'always',
      meta: { silentError: true },
    }),
    assign: useMutation({
      mutationFn: (v: { id: string; assignedToUserId: string | null; dueOn?: string | null }) =>
        post<CaseView>(`/follow-up/cases/${v.id}/assign`, {
          assignedToUserId: v.assignedToUserId,
          ...(v.dueOn !== undefined ? { dueOn: v.dueOn } : {}),
        }),
      onSuccess: done,
    }),
    close: useMutation({
      mutationFn: (v: { id: string; status: 'RESOLVED' | 'DISMISSED'; reason: string }) =>
        post<{ changed: boolean; case: CaseView }>(
          `/follow-up/cases/${v.id}/${v.status === 'RESOLVED' ? 'resolve' : 'dismiss'}`,
          { reason: v.reason },
        ),
      onSuccess: done,
      onError: done,
    }),
    logContact: useMutation({
      mutationFn: (v: {
        academyStudentId: string;
        requestKey: string;
        channel: Channel;
        outcome: Outcome;
        party: Party;
        guardianLinkId?: string;
        followUpId?: string;
        note?: string;
      }) => {
        const { academyStudentId, ...body } = v;
        return post<{ created: boolean; contact: ContactView }>(
          `/follow-up/students/${academyStudentId}/contacts`,
          body,
        );
      },
      onSuccess: done,
      networkMode: 'always',
      meta: { silentError: true },
    }),
    updateSettings: useMutation({
      mutationFn: (v: Partial<FollowUpSettings>) =>
        api.patch<FollowUpSettings>('/follow-up/settings', v, at(academyId)).then((r) => r.data),
      onSuccess: done,
    }),
  };
}

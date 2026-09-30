import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useStaffAcademyStore } from '../stores/staffAcademy';

/**
 * Center Operations C2 — weekly timetables, real classes and their
 * attendance. Every call goes to the academy this person is acting in (the
 * X-Academy-Id interceptor in lib/api.ts); the server decides every time and
 * every derived fact (late, closed, expected) — this module only asks and shows.
 *
 * Times: the server sends each class's LOCAL date and HH:MM in the academy's
 * timezone. Screens show those strings as they are; nothing here converts a
 * class time through the browser's clock, so a phone set to another zone
 * still shows 18:00 for an 18:00 class.
 */

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED';
export type ClassStatus = 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';

export interface ClassAccess {
  enabled: boolean;
  canAttend: boolean;
  canSchedule: boolean;
  canManageGroups: boolean;
  timezone: string | null;
  today: string | null;
  lateGraceMin: number | null;
}

export interface ClassView {
  id: string;
  group: { id: string; name: string };
  teacher: { id: string; fullName: string } | null;
  room: { id: string; name: string } | null;
  mode: 'PHYSICAL' | 'HYBRID' | 'ONLINE';
  locationType: string | null;
  locationNote: string | null;
  status: ClassStatus;
  startAt: string;
  endAt: string;
  /** Local date and times in the academy's clock. */
  date: string;
  startTime: string;
  endTime: string;
  startedAt: string | null;
  fromTimetable: boolean;
}

export interface ClassSummary extends ClassView {
  closedAt: string | null;
  capacity: number | null;
  counts: {
    expected: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    makeup: number;
  };
}

export interface RosterStudent {
  studentId: string;
  fullName: string;
  code: string | null;
  avatarUrl: string | null;
  expected: boolean;
  status: AttendanceStatus | null;
  method: 'MANUAL' | 'AUTO' | null;
  checkedInAt: string | null;
  makeup: {
    homeGroup: { id: string; name: string };
    forSession: { id: string; date: string; time: string } | null;
  } | null;
}

export interface ClassRoster {
  session: ClassView;
  timezone: string;
  graceMin: number;
  lateAfter: string;
  now: string;
  closedAt: string | null;
  canMark: boolean;
  canClose: boolean;
  canStart: boolean;
  /** Past its end time. */
  ended: boolean;
  capacity: number | null;
  counts: Record<AttendanceStatus | 'UNMARKED' | 'MAKEUP', number>;
  students: RosterStudent[];
}

export interface Slot {
  id: string;
  groupId: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  roomId: string | null;
  room: { id: string; name: string } | null;
  teacherUserId: string | null;
  teacher: { id: string; fullName: string } | null;
  locationType: 'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  locationNote: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface SlotChangeSummary {
  updated: number;
  removed: number;
  created: number;
  kept: number;
  from: string;
}

export interface SlotInput {
  weekday: number;
  startTime: string;
  durationMin: number;
  roomId?: string | null;
  teacherUserId?: string | null;
  locationType?: 'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  locationNote?: string | null;
  validFrom?: string;
  validTo?: string | null;
}

export interface GroupOptions {
  rooms: { id: string; name: string; capacity: number | null }[];
  teachers: { id: string; fullName: string }[];
  subjects: { id: string; nameAr: string; nameEn: string }[];
  grades: { id: string; nameAr: string; nameEn: string }[];
  kind: 'PERSONAL' | 'CENTER';
}

export interface MakeupCandidate {
  studentId: string;
  fullName: string;
  code: string;
  belongsHere: boolean;
  groups: { id: string; name: string }[];
  missed: {
    sessionId: string;
    status: AttendanceStatus;
    group: { id: string; name: string };
    date: string;
    time: string;
  }[];
}

const key = () => `c2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Send a call to one named academy (a class opened from another workspace). */
const at = (academyId?: string) => (academyId ? { headers: { 'X-Academy-Id': academyId } } : {});

function useAcademyKey() {
  return useStaffAcademyStore((s) => s.academyId) ?? 'self';
}

/** Is C2 on here, and what may I do — for menus and tabs; never a refusal. */
export function useClassAccess(enabled = true) {
  const academy = useAcademyKey();
  return useQuery<ClassAccess>({
    queryKey: ['class-access', academy],
    queryFn: async () => (await api.get('/class-ops/access')).data,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export interface MyClassesDay {
  academies: {
    academy: { id: string; name: string; slug: string };
    date: string;
    today: string;
    timezone: string;
    classes: ClassSummary[];
  }[];
}

/** Anywhere I take attendance, across every workspace (a Center teacher's home is usually their own academy). */
export function useMyClassAccess(enabled = true) {
  return useQuery<{ enabled: boolean; academies: { id: string; name: string; slug: string }[] }>({
    queryKey: ['my-class-access'],
    queryFn: async () => (await api.get('/class-ops/my-access')).data,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** My classes of one day in every workspace where I take attendance. */
export function useMyClassDay(date: string | undefined, enabled = true) {
  return useQuery<MyClassesDay>({
    queryKey: ['class-day', 'mine', date ?? 'today'],
    queryFn: async () =>
      (await api.get('/class-ops/my-day', { params: date ? { date } : {} })).data,
    enabled,
    refetchInterval: 60_000,
  });
}

export function useClassDay(date: string | undefined, enabled = true) {
  const academy = useAcademyKey();
  return useQuery<{ date: string; today: string; timezone: string; classes: ClassSummary[] }>({
    queryKey: ['class-day', academy, date ?? 'today'],
    queryFn: async () => (await api.get('/class-ops/day', { params: date ? { date } : {} })).data,
    enabled,
    refetchInterval: 60_000,
  });
}

export function useGroupClasses(
  groupId: string | undefined,
  from: string,
  to: string,
  enabled = true,
) {
  return useQuery<{ timezone: string; today: string; classes: ClassSummary[] }>({
    queryKey: ['group-classes', groupId, from, to],
    queryFn: async () =>
      (await api.get(`/class-ops/groups/${groupId}/classes`, { params: { from, to } })).data,
    enabled: enabled && !!groupId && !!from && !!to,
  });
}

export function useClassRoster(sessionId: string | undefined, academyId?: string) {
  return useQuery<ClassRoster>({
    queryKey: ['class-roster', sessionId],
    queryFn: async () => (await api.get(`/class-ops/sessions/${sessionId}`, at(academyId))).data,
    enabled: !!sessionId,
    // Another device at the door may be marking the same class.
    refetchInterval: 20_000,
  });
}

/** After any change to a class: its roster (from the answer) and the lists showing it. */
function useClassWrite<TVars>(sessionId: string, fn: (vars: TVars) => Promise<ClassRoster>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (roster) => {
      qc.setQueryData(['class-roster', sessionId], roster);
      void qc.invalidateQueries({ queryKey: ['class-day'] });
      void qc.invalidateQueries({ queryKey: ['group-classes'] });
    },
  });
}

export function useStartClass(sessionId: string, academyId?: string) {
  return useClassWrite<void>(
    sessionId,
    async () =>
      (await api.post(`/class-ops/sessions/${sessionId}/start`, undefined, at(academyId))).data,
  );
}

export function useMarkAttendance(sessionId: string, academyId?: string) {
  return useClassWrite<{ studentId: string; status: AttendanceStatus }[]>(
    sessionId,
    async (records) =>
      (await api.post(`/class-ops/sessions/${sessionId}/attendance`, { records }, at(academyId)))
        .data,
  );
}

export function useCloseAttendance(sessionId: string, academyId?: string) {
  return useClassWrite<void>(
    sessionId,
    async () =>
      (await api.post(`/class-ops/sessions/${sessionId}/close`, undefined, at(academyId))).data,
  );
}

export function useAddMakeup(sessionId: string, academyId?: string) {
  return useClassWrite<{ studentId: string; homeGroupId?: string; makeupForSessionId?: string }>(
    sessionId,
    async (dto) =>
      (await api.post(`/class-ops/sessions/${sessionId}/makeup`, dto, at(academyId))).data,
  );
}

export function useMakeupCandidates(sessionId: string, q: string, academyId?: string) {
  const query = q.trim();
  return useQuery<{ mode: 'CODE' | 'NAME' | 'CODE_ONLY'; candidates: MakeupCandidate[] }>({
    queryKey: ['makeup-candidates', sessionId, query],
    queryFn: async () =>
      (
        await api.get(`/class-ops/sessions/${sessionId}/makeup-candidates`, {
          params: { q: query },
          ...at(academyId),
        })
      ).data,
    enabled: query.length >= 2,
    placeholderData: (prev) => prev,
  });
}

/** Cancel ONE class (the timetable is not touched). */
export function useCancelClass() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) =>
      (await api.patch(`/teacher/sessions/${sessionId}`, { status: 'CANCELLED' })).data,
    onSuccess: (_d, sessionId) => {
      void qc.invalidateQueries({ queryKey: ['class-roster', sessionId] });
      void qc.invalidateQueries({ queryKey: ['class-day'] });
      void qc.invalidateQueries({ queryKey: ['group-classes'] });
    },
  });
}

// ── Timetable ─────────────────────────────────────────────────────────────

export function useGroupOptions(groupId: string | undefined, enabled = true) {
  return useQuery<GroupOptions>({
    queryKey: ['group-options', groupId],
    queryFn: async () => (await api.get(`/class-ops/groups/${groupId}/options`)).data,
    enabled: enabled && !!groupId,
    staleTime: 60_000,
  });
}

export function useSlots(groupId: string | undefined, enabled = true) {
  return useQuery<Slot[]>({
    queryKey: ['group-slots', groupId],
    queryFn: async () => (await api.get(`/class-ops/groups/${groupId}/slots`)).data,
    enabled: enabled && !!groupId,
  });
}

function useTimetableWrite<TVars, TOut>(groupId: string, fn: (v: TVars) => Promise<TOut>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['group-slots', groupId] });
      void qc.invalidateQueries({ queryKey: ['group-classes', groupId] });
      void qc.invalidateQueries({ queryKey: ['class-day'] });
    },
  });
}

export function useCreateSlot(groupId: string) {
  return useTimetableWrite<SlotInput & { requestKey: string }, Slot>(
    groupId,
    async (dto) => (await api.post(`/class-ops/groups/${groupId}/slots`, dto)).data,
  );
}

/** A fresh idempotency key for one save (kept across retries of that save). */
export const newRequestKey = key;

export function useUpdateSlot(groupId: string) {
  return useTimetableWrite<
    { slotId: string; dto: Partial<SlotInput>; dryRun?: boolean },
    { slot: Slot | null; summary: SlotChangeSummary; dryRun?: boolean }
  >(
    groupId,
    async ({ slotId, dto, dryRun }) =>
      (await api.patch(`/class-ops/slots/${slotId}`, { ...dto, ...(dryRun ? { dryRun } : {}) }))
        .data,
  );
}

export function useDeleteSlot(groupId: string) {
  return useTimetableWrite<
    { slotId: string; dryRun?: boolean },
    { summary: SlotChangeSummary; dryRun?: boolean }
  >(
    groupId,
    async ({ slotId, dryRun }) =>
      (await api.delete(`/class-ops/slots/${slotId}`, { params: dryRun ? { dryRun: 1 } : {} }))
        .data,
  );
}

export function useTransferMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { studentId: string; toGroupId: string }) =>
      (
        await api.post(`/teacher/groups/${groupId}/members/${v.studentId}/transfer`, {
          toGroupId: v.toGroupId,
        })
      ).data,
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['teacher-group', groupId] });
      void qc.invalidateQueries({ queryKey: ['teacher-group', v.toGroupId] });
      void qc.invalidateQueries({ queryKey: ['teacher-groups'] });
      void qc.invalidateQueries({ queryKey: ['registry'] });
    },
  });
}

/** Group seats/subject/year/grace — the C2 part of a group's settings. */
export function useUpdateGroupConfig(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (dto: {
      subjectId?: string | null;
      gradeId?: string | null;
      capacity?: number | null;
      lateGraceMin?: number | null;
    }) => (await api.patch(`/teacher/groups/${groupId}`, dto)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teacher-group', groupId] });
      void qc.invalidateQueries({ queryKey: ['teacher-groups'] });
    },
  });
}

// ── Formatting (no clock conversion — see the module comment) ────────────

/** 'YYYY-MM-DD' as a weekday + day + month in the reader's language. */
export function formatLocalDate(date: string, lang: string, opts: Intl.DateTimeFormatOptions = {}) {
  // A date not known yet (still loading) is shown as nothing, never a crash.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    ...opts,
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** 'HH:MM' (24h) as the reader expects to read a clock: 6:00 م / 6:00 PM. */
export function formatClock(hhmm: string, lang: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: lang !== 'en',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
}

/** An instant as HH:MM in the academy's timezone (a check-in time). */
export function formatInstant(iso: string, timezone: string, lang: string) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG-u-nu-latn', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: lang !== 'en',
    timeZone: timezone,
  }).format(new Date(iso));
}

/** 'YYYY-MM-DD' ± days, calendar-only. */
export function shiftDate(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

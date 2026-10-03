import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Center Operations C7 — the day's operations and its close.
 *
 * Everything on the page is computed by the server from the day's sources
 * (classes, attendance, desk check-ins, collections and reversals, follow-up,
 * exams). A close freezes those figures as a version; closing again after a
 * correction adds the next version. Nothing here changes attendance or money.
 */

export interface DailyAccess {
  enabled: boolean;
  canView: boolean;
  canClose: boolean;
}

export interface DayFigures {
  classes: {
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
    ended: number;
    upcoming: number;
  };
  attendance: {
    expected: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    makeup: number;
    unmarked: number;
    closedClasses: number;
    openClasses: number;
  };
  desk: { checkIns: number; byCard: number; byCode: number } | null;
  collections: {
    currency: string;
    received: {
      count: number;
      amountCents: number;
      byMethod: Record<string, { count: number; amountCents: number }>;
    };
    reversedToday: { count: number; amountCents: number };
    netCents: number;
  } | null;
  followUp: {
    opened: number;
    resolved: number;
    dismissed: number;
    contacts: number;
    state: { openCases: number };
  } | null;
  exams: { published: number; corrections: number; state: { draftsDue: number } } | null;
}

export interface DayClass {
  id: string;
  groupId: string;
  groupName: string;
  startAt: string;
  endAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  attendanceClosed: boolean;
  expected: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  makeup: number;
  checkIns: number;
}

export interface DayException {
  code: 'ATTENDANCE_NOT_CLOSED' | 'CLASS_NOT_ENDED';
  sessionId: string;
  groupName: string;
  startAt: string;
  unmarked: number;
}

export interface DayView {
  date: string;
  today: string;
  timezone: string;
  computedAt: string;
  figures: DayFigures;
  classes: DayClass[];
  exceptions: DayException[];
  closes: {
    version: number;
    closedAt: string;
    closedBy: string;
    exceptions: number;
    exceptionNote: string | null;
    reason: string | null;
  }[];
  latest: {
    version: number;
    figures: DayFigures;
    exceptions: DayException[];
    drift: string[];
  } | null;
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function useDailyAccess(academyId?: string) {
  return useQuery<DailyAccess>({
    queryKey: ['day-access', academyId],
    queryFn: async () => (await api.get('/daily-ops/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useDay(academyId: string | undefined, date: string | undefined, enabled = true) {
  return useQuery<DayView>({
    queryKey: ['day', academyId, date ?? 'today'],
    queryFn: async () =>
      (await api.get('/daily-ops/day', { ...at(academyId), params: date ? { date } : {} })).data,
    enabled: !!academyId && enabled,
    // Figures move while the day runs: refresh when the page is looked at again.
    refetchOnWindowFocus: true,
  });
}

export function useCloseDay(academyId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      date: string;
      requestKey: string;
      exceptionNote?: string;
      reason?: string;
    }) =>
      api
        .post<{ created: boolean; version: number; closedAt: string }>(
          '/daily-ops/close',
          v,
          at(academyId),
        )
        .then((r) => r.data),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['day', academyId] }),
    // Offline must say so; a retry reuses the same request key, so it is one close.
    networkMode: 'always',
    meta: { silentError: true },
  });
}

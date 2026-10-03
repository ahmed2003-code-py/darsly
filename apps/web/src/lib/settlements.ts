import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Center Operations C8 — what the CENTER owes and pays its TEACHERS.
 *
 * Its own books, never Darsly's money and never the students' fees. Every
 * figure is the server's: a preview is computed from the classes and
 * collections themselves; a finalized settlement is frozen; payments are only
 * a record that the center paid ("not a payout").
 */

export type PayMethod = 'PER_SESSION' | 'PERCENT_OF_COLLECTIONS' | 'FIXED_PERIOD';
export type SettlementStatus = 'FINALIZED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';

export interface SettlementAccess {
  enabled: boolean;
  canView: boolean;
  canManage: boolean;
  canFinalize: boolean;
  canPay: boolean;
}

export interface Agreement {
  id: string;
  teacherUserId: string;
  method: PayMethod;
  currency: string;
  rateCents: number | null;
  percentBps: number | null;
  groupIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  ended: boolean;
}

export interface TeacherRow {
  userId: string;
  name: string;
  agreements: Agreement[];
}

export interface Line {
  kind: 'SESSION' | 'COLLECTION' | 'FIXED';
  sourceId: string;
  agreementId: string;
  amountCents: number;
  detail: Record<string, unknown>;
}

export interface Preview {
  teacherUserId: string;
  from: string;
  to: string;
  today: string;
  timezone: string;
  currency: string;
  agreements: Agreement[];
  lines: Line[];
  pending: {
    sessionId: string;
    groupName: string;
    startAt: string;
    why: 'NOT_ENDED' | 'ATTENDANCE_OPEN';
  }[];
  grossCents: number;
  overlapsSettlement: { id: string; from: string; to: string } | null;
}

export interface SettlementSummary {
  id: string;
  teacherUserId: string;
  teacherName?: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  status: SettlementStatus;
  grossCents: number;
  adjustCents: number;
  payableCents: number;
  paidCents: number;
  remainingCents: number;
  finalizedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
}

export interface Settlement extends SettlementSummary {
  timezone: string;
  teacherName: string;
  finalizedByName: string;
  lines: Line[];
  adjustments: {
    id: string;
    kind: 'BONUS' | 'DEDUCTION' | 'CORRECTION';
    amountCents: number;
    reason: string;
    createdAt: string;
    by: string;
  }[];
  payments: {
    id: string;
    amountCents: number;
    method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
    reference: string | null;
    paidAt: string;
    by: string;
  }[];
  drift: {
    added: Line[];
    removed: Line[];
    changed: { sourceId: string; was: number; now: number }[];
    deltaCents: number;
  } | null;
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function useSettlementAccess(academyId?: string) {
  return useQuery<SettlementAccess>({
    queryKey: ['ts-access', academyId],
    queryFn: async () => (await api.get('/teacher-settlement/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useTeachers(academyId: string | undefined, enabled = true) {
  return useQuery<TeacherRow[]>({
    queryKey: ['ts-teachers', academyId],
    queryFn: async () => (await api.get('/teacher-settlement/teachers', at(academyId))).data,
    enabled: !!academyId && enabled,
  });
}

export function useSettlementGroups(academyId: string | undefined, enabled = true) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['ts-groups', academyId],
    queryFn: async () => (await api.get('/teacher-settlement/groups', at(academyId))).data,
    enabled: !!academyId && enabled,
    staleTime: 60_000,
  });
}

export function usePreview(
  academyId: string | undefined,
  q: { teacherUserId?: string; from?: string; to?: string },
) {
  return useQuery<Preview>({
    queryKey: ['ts-preview', academyId, q],
    queryFn: async () =>
      (await api.get('/teacher-settlement/preview', { ...at(academyId), params: q })).data,
    enabled: !!academyId && !!q.teacherUserId && !!q.from && !!q.to && q.from <= q.to,
    retry: false,
  });
}

export function useSettlements(
  academyId: string | undefined,
  q: { teacherUserId?: string; page: number },
  enabled = true,
) {
  return useQuery<{ total: number; page: number; pageSize: number; items: SettlementSummary[] }>({
    queryKey: ['ts-list', academyId, q],
    queryFn: async () =>
      (
        await api.get('/teacher-settlement/settlements', {
          ...at(academyId),
          params: { ...(q.teacherUserId ? { teacherUserId: q.teacherUserId } : {}), page: q.page },
        })
      ).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useSettlement(academyId: string | undefined, id: string | undefined) {
  return useQuery<Settlement>({
    queryKey: ['ts-one', academyId, id],
    queryFn: async () =>
      (await api.get(`/teacher-settlement/settlements/${id}`, at(academyId))).data,
    enabled: !!academyId && !!id,
    retry: false,
  });
}

export async function downloadStatement(academyId: string, id: string) {
  const r = await api.get(`/teacher-settlement/settlements/${id}/statement`, {
    ...at(academyId),
    responseType: 'blob',
  });
  const cd = String(r.headers['content-disposition'] ?? '');
  return { blob: r.data as Blob, filename: /filename="([^"]+)"/.exec(cd)?.[1] ?? 'settlement.csv' };
}

export function useSettlementActions(academyId: string | undefined) {
  const qc = useQueryClient();
  const done = () => {
    for (const k of ['ts-teachers', 'ts-preview', 'ts-list', 'ts-one'])
      void qc.invalidateQueries({ queryKey: [k, academyId] });
  };
  const cfg = at(academyId);
  const post = <T>(url: string, body: unknown) => api.post<T>(url, body, cfg).then((r) => r.data);
  const common = { onSettled: done, networkMode: 'always' as const, meta: { silentError: true } };
  return {
    createAgreement: useMutation({
      mutationFn: (v: {
        requestKey: string;
        teacherUserId: string;
        method: PayMethod;
        rateCents?: number;
        percentBps?: number;
        groupIds?: string[];
        effectiveFrom: string;
        effectiveTo?: string;
      }) => post<{ created: boolean; agreement: Agreement }>('/teacher-settlement/agreements', v),
      ...common,
    }),
    endAgreement: useMutation({
      mutationFn: (v: { id: string; effectiveTo: string }) =>
        post<Agreement>(`/teacher-settlement/agreements/${v.id}/end`, {
          effectiveTo: v.effectiveTo,
        }),
      ...common,
    }),
    finalize: useMutation({
      mutationFn: (v: {
        requestKey: string;
        teacherUserId: string;
        from: string;
        to: string;
        expectedGrossCents: number;
      }) =>
        post<{ created: boolean; settlement: Settlement }>('/teacher-settlement/settlements', v),
      ...common,
    }),
    voidSettlement: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        post<Settlement>(`/teacher-settlement/settlements/${v.id}/void`, { reason: v.reason }),
      ...common,
    }),
    adjust: useMutation({
      mutationFn: (v: {
        id: string;
        requestKey: string;
        kind: 'BONUS' | 'DEDUCTION' | 'CORRECTION';
        amountCents: number;
        reason: string;
      }) => {
        const { id, ...body } = v;
        return post<{ replayed: boolean; settlement: Settlement }>(
          `/teacher-settlement/settlements/${id}/adjustments`,
          body,
        );
      },
      ...common,
    }),
    pay: useMutation({
      mutationFn: (v: {
        id: string;
        requestKey: string;
        amountCents: number;
        method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
        reference?: string;
      }) => {
        const { id, ...body } = v;
        return post<{ replayed: boolean; settlement: Settlement }>(
          `/teacher-settlement/settlements/${id}/payments`,
          body,
        );
      },
      ...common,
    }),
  };
}

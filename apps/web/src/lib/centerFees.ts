import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Center Operations C4 — the center's own fees: what a learner owes, what
 * was collected, receipts. This is NOT platform money (course payments,
 * wallets, payouts live elsewhere and never here).
 *
 * Every amount is an integer of minor units (piasters): the API only takes
 * and returns integers; this file turns typed text into them with string
 * arithmetic and never uses a float for a stored value. The server decides
 * balances, due/overdue (its clock, the academy's timezone), allocations,
 * receipt numbers.
 */

export type Method = 'CASH' | 'CARD_EXTERNAL' | 'BANK_TRANSFER' | 'OTHER';
export const METHODS: Method[] = ['CASH', 'CARD_EXTERNAL', 'BANK_TRANSFER', 'OTHER'];
export type ChargeStatus = 'VOID' | 'PAID' | 'OVERDUE' | 'PARTIALLY_PAID' | 'DUE' | 'UPCOMING';

export interface FeesAccess {
  enabled: boolean;
  canView: boolean;
  canCollect: boolean;
  canManage: boolean;
  canAdjust: boolean;
  canReverse: boolean;
  canReport: boolean;
  currency: string | null;
}

export interface FeeSummary {
  currency: string;
  today: string;
  outstandingCents: number;
  overdueCents: number;
  openCharges: number;
  nextDue: { dueOn: string; outstandingCents: number; description: string } | null;
}

export interface Charge {
  id: string;
  kind: 'MONTHLY' | 'PER_SESSION' | 'ONE_TIME';
  description: string;
  period: string | null;
  sessionDate: string | null;
  amountCents: number;
  netCents: number;
  paidCents: number;
  outstandingCents: number;
  dueOn: string;
  status: ChargeStatus;
  voidReason: string | null;
  adjustments: {
    id: string;
    kind: 'DISCOUNT' | 'CORRECTION';
    deltaCents: number;
    percentBps: number | null;
    reason: string;
    createdAt: string;
  }[];
}

export interface Collection {
  id: string;
  /** The academy's local date of the collection. */
  localDate: string;
  receiptNumber: string;
  amountCents: number;
  currency: string;
  method: Method;
  note: string | null;
  receivedAt: string;
  balanceAfterCents: number;
  reversedAt: string | null;
  reversalReason: string | null;
  allocations: { chargeId: string; amountCents: number }[];
}

export interface StudentFees {
  student: { id: string; fullName: string; code: string; status: string };
  summary: FeeSummary;
  charges: Charge[];
  collections: Collection[];
}

export interface Receipt {
  academy: { name: string; logoUrl: string | null };
  receiptNumber: string;
  receivedAt: string;
  localDate: string;
  localMinute: number;
  timezone: string;
  student: { id: string; fullName: string; code: string };
  collector: string;
  amountCents: number;
  currency: string;
  method: Method;
  note: string | null;
  lines: {
    description: string;
    period: string | null;
    kind: Charge['kind'];
    amountCents: number;
  }[];
  balanceAfterCents: number;
  reversed: { at: string; reason: string | null; by: string } | null;
  collectionId: string;
}

export interface Preview {
  student: { id: string; fullName: string; code: string };
  currency: string;
  amountCents: number;
  balanceBeforeCents: number;
  balanceAfterCents: number;
  allocations: {
    chargeId: string;
    amountCents: number;
    description: string;
    period: string | null;
    dueOn: string;
    outstandingCents: number;
  }[];
}

export interface Plan {
  id: string;
  name: string;
  type: 'MONTHLY' | 'PER_SESSION';
  amountCents: number;
  currency: string;
  dueDay: number | null;
  startsOn: string;
  status: 'ACTIVE' | 'ARCHIVED';
  group: { id: string; name: string };
  charges: number;
}

// ── Money ────────────────────────────────────────────────────────────────

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * Typed text → minor units, or null if it is not an amount. "500", "500.5",
 * "1,500.25", "٥٠٠٫٧٥" (Arabic digits and decimal sign) all work; a comma is
 * read as a thousands separator; more than two decimals is refused (no silent
 * rounding of money). Pure string arithmetic — no float.
 */
export function parseMoney(text: string): number | null {
  let s = '';
  for (const ch of text.trim()) {
    const a = AR_DIGITS.indexOf(ch);
    const f = FA_DIGITS.indexOf(ch);
    s += a >= 0 ? String(a) : f >= 0 ? String(f) : ch === '٫' ? '.' : ch;
  }
  s = s.replace(/[,\s٬']/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

/** Minor units as a plain decimal string: 50000 → "500.00". */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * How an amount reads: "500.00 ج.م" / "EGP 500.00" — always two decimals and
 * the currency, so an extra zero is hard to miss. Western digits, as the rest
 * of the app.
 */
export function formatMoney(cents: number, currency: string, lang: string): string {
  const dec = centsToDecimal(cents);
  try {
    return new Intl.NumberFormat(lang === 'en' ? 'en-EG' : 'ar-EG-u-nu-latn', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(dec as unknown as number);
  } catch {
    return `${dec} ${currency}`;
  }
}

/** A fresh identity for one collection attempt — retries reuse it. */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// ── Hooks ────────────────────────────────────────────────────────────────

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function useFeesAccess(academyId?: string) {
  return useQuery<FeesAccess>({
    queryKey: ['fees-access', academyId],
    queryFn: async () => (await api.get('/center-fees/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useFeeSummary(
  academyId: string | undefined,
  academyStudentId: string | undefined,
  enabled = true,
) {
  return useQuery<FeeSummary>({
    queryKey: ['fees-summary', academyId, academyStudentId],
    queryFn: async () =>
      (await api.get(`/center-fees/students/${academyStudentId}/summary`, at(academyId))).data,
    enabled: !!academyId && !!academyStudentId && enabled,
    meta: { silentError: true },
  });
}

export function useStudentFees(
  academyId: string | undefined,
  academyStudentId: string | undefined,
  enabled = true,
) {
  return useQuery<StudentFees>({
    queryKey: ['fees-student', academyId, academyStudentId],
    queryFn: async () =>
      (await api.get(`/center-fees/students/${academyStudentId}`, at(academyId))).data,
    enabled: !!academyId && !!academyStudentId && enabled,
  });
}

export async function fetchStatement(academyId: string, academyStudentId: string) {
  return (await api.get(`/center-fees/students/${academyStudentId}/statement`, at(academyId)))
    .data as {
    academy: { name: string };
    student: StudentFees['student'];
    summary: FeeSummary;
    events: {
      at: string;
      localDate: string;
      kind: string;
      label: string;
      ref?: string;
      deltaCents: number;
      balanceCents: number;
    }[];
  };
}

export async function fetchReceipt(academyId: string, collectionId: string): Promise<Receipt> {
  return (await api.get(`/center-fees/collections/${collectionId}`, at(academyId))).data;
}

export function useOutstanding(
  academyId: string | undefined,
  f: { q: string; status: string; page: number },
  enabled = true,
) {
  return useQuery({
    queryKey: ['fees-outstanding', academyId, f.q, f.status, f.page],
    queryFn: async () =>
      (
        await api.get('/center-fees/outstanding', {
          ...at(academyId),
          params: { ...(f.q ? { q: f.q } : {}), status: f.status, page: f.page },
        })
      ).data as {
        currency: string;
        total: number;
        page: number;
        pageSize: number;
        totals: { outstandingCents: number; overdueCents: number; studentsOwing: number };
        items: {
          id: string;
          fullName: string;
          code: string;
          status: string;
          outstanding: number;
          overdue: number;
          paid: number;
          oldestDue: string | null;
        }[];
      },
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useFeesDay(
  academyId: string | undefined,
  date: string | undefined,
  page: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['fees-day', academyId, date ?? 'today', page],
    queryFn: async () =>
      (
        await api.get('/center-fees/collections', {
          ...at(academyId),
          params: { ...(date ? { date } : {}), page },
        })
      ).data as {
        date: string;
        today: string;
        timezone: string;
        currency: string;
        scope: 'MINE' | 'ALL';
        totals: {
          count: number;
          amountCents: number;
          byMethod: Record<Method, { count: number; amountCents: number }>;
          reversed: { count: number; amountCents: number };
        };
        total: number;
        pageSize: number;
        items: (Collection & {
          student: { id: string; fullName: string; code: string };
          collector: string;
        })[];
      },
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function usePlans(academyId: string | undefined, enabled = true) {
  return useQuery<Plan[]>({
    queryKey: ['fees-plans', academyId],
    queryFn: async () => (await api.get('/center-fees/plans', at(academyId))).data,
    enabled: !!academyId && enabled,
  });
}

export function useFeeGroups(academyId: string | undefined, enabled = true) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['fees-groups', academyId],
    queryFn: async () => (await api.get('/center-fees/groups', at(academyId))).data,
    enabled: !!academyId && enabled,
  });
}

/** Everything that shows a balance refreshes after a money write. */
function useFeesInvalidate(academyId?: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of ['fees-summary', 'fees-student', 'fees-outstanding', 'fees-day', 'fees-plans'])
      void qc.invalidateQueries({ queryKey: [k, academyId] });
  };
}

export function useFeesActions(academyId: string | undefined) {
  const done = useFeesInvalidate(academyId);
  const post = <T>(url: string, body: unknown) =>
    api.post<T>(url, body, at(academyId)).then((r) => r.data);
  return {
    preview: useMutation({
      mutationFn: (v: {
        academyStudentId: string;
        amountCents: number;
        allocations?: { chargeId: string; amountCents: number }[];
      }) =>
        post<Preview>(`/center-fees/students/${v.academyStudentId}/collections/preview`, {
          amountCents: v.amountCents,
          ...(v.allocations ? { allocations: v.allocations } : {}),
        }),
      meta: { silentError: true },
      networkMode: 'always',
    }),
    collect: useMutation({
      mutationFn: (v: {
        academyStudentId: string;
        requestKey: string;
        amountCents: number;
        method: Method;
        note?: string;
        allocations?: { chargeId: string; amountCents: number }[];
      }) =>
        post<{ replayed: boolean; receipt: Receipt }>(
          `/center-fees/students/${v.academyStudentId}/collections`,
          {
            requestKey: v.requestKey,
            amountCents: v.amountCents,
            method: v.method,
            ...(v.note ? { note: v.note } : {}),
            ...(v.allocations ? { allocations: v.allocations } : {}),
          },
        ),
      onSuccess: done,
      meta: { silentError: true },
      // Offline must say so; never park a money request until the network returns.
      networkMode: 'always',
    }),
    reverse: useMutation({
      mutationFn: (v: { collectionId: string; reason: string }) =>
        post<{ changed: boolean; receipt: Receipt }>(
          `/center-fees/collections/${v.collectionId}/reverse`,
          { reason: v.reason },
        ),
      onSuccess: done,
    }),
    oneTime: useMutation({
      mutationFn: (v: {
        academyStudentId: string;
        requestKey: string;
        description: string;
        amountCents: number;
        dueOn: string;
      }) =>
        post<StudentFees>(`/center-fees/students/${v.academyStudentId}/charges`, {
          requestKey: v.requestKey,
          description: v.description,
          amountCents: v.amountCents,
          dueOn: v.dueOn,
        }),
      onSuccess: done,
    }),
    monthly: useMutation({
      mutationFn: (v: { academyStudentId: string; planId: string }) =>
        post<{ posted: number }>(`/center-fees/students/${v.academyStudentId}/monthly`, {
          planId: v.planId,
        }),
      onSuccess: done,
    }),
    adjust: useMutation({
      mutationFn: (v: {
        chargeId: string;
        requestKey: string;
        kind: 'DISCOUNT' | 'CORRECTION';
        amountCents?: number;
        percentBps?: number;
        direction?: 'INCREASE' | 'DECREASE';
        reason: string;
      }) => {
        const { chargeId, ...body } = v;
        return post<StudentFees>(`/center-fees/charges/${chargeId}/adjustments`, body);
      },
      onSuccess: done,
    }),
    voidCharge: useMutation({
      mutationFn: (v: { chargeId: string; reason: string }) =>
        post<StudentFees>(`/center-fees/charges/${v.chargeId}/void`, { reason: v.reason }),
      onSuccess: done,
    }),
    createPlan: useMutation({
      mutationFn: (v: {
        name: string;
        groupId: string;
        type: Plan['type'];
        amountCents: number;
        dueDay?: number;
        startsOn?: string;
      }) => post<Plan & { posted: number }>('/center-fees/plans', v),
      onSuccess: done,
    }),
    updatePlan: useMutation({
      mutationFn: (v: {
        id: string;
        name?: string;
        amountCents?: number;
        dueDay?: number;
        status?: Plan['status'];
      }) => {
        const { id, ...body } = v;
        return api.patch<Plan>(`/center-fees/plans/${id}`, body, at(academyId)).then((r) => r.data);
      },
      onSuccess: done,
    }),
    generate: useMutation({
      mutationFn: (planId: string) =>
        post<{ posted: number }>(`/center-fees/plans/${planId}/generate`, {}),
      onSuccess: done,
    }),
  };
}

export async function downloadFeesCsv(
  academyId: string,
  kind: 'outstanding' | 'collections',
  date?: string,
) {
  const res = await api.get(`/center-fees/${kind}/export`, {
    ...at(academyId),
    params: date ? { date } : {},
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kind}-${date ?? new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

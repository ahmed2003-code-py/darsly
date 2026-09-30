import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AttendanceStatus } from './classOps';

/**
 * Center Operations C3 — the reception desk and QR student cards.
 *
 * The server decides everything: who a card or code belongs to, which class
 * is theirs now, PRESENT or LATE (its clock), makeup seats, closed sheets.
 * This module asks and shows. Card tokens travel only in POST bodies — never
 * in a URL, a query string, localStorage or a log.
 */

export interface DeskAccess {
  enabled: boolean;
  canCheckIn: boolean;
  canManageCards: boolean;
  canSearch: boolean;
  canRegister: boolean;
  classes: boolean;
}

export type DeskClassState = 'OPEN' | 'NOT_YET' | 'ENDED' | 'CLOSED' | 'CANCELLED';
export type DeskMethod = 'QR' | 'CODE' | 'MANUAL' | 'AUTO';

export interface DeskClass {
  sessionId: string;
  kind: 'HOME' | 'MAKEUP';
  state: DeskClassState;
  group: { id: string; name: string };
  room: { id: string; name: string } | null;
  teacher: { fullName: string } | null;
  startAt: string;
  endAt: string;
  startTime: string;
  endTime: string;
  lateNow: boolean;
  attendance: { status: AttendanceStatus; method: DeskMethod; checkedInAt: string | null } | null;
  capacity: number | null;
  seated: number | null;
  full: boolean;
}

export type DeskAction =
  | { kind: 'CHECK_IN'; sessionId: string }
  | { kind: 'ALREADY'; sessionId: string; status: AttendanceStatus }
  | { kind: 'CHOOSE' }
  | { kind: 'NO_CLASS'; reason: 'NONE_OPEN' | 'CLASSES_OFF'; nextSessionId?: string | null }
  | { kind: 'WITHDRAWN' };

export interface DeskView {
  student: {
    id: string;
    studentId: string;
    fullName: string;
    code: string;
    status: 'ACTIVE' | 'WITHDRAWN';
    grade: { nameAr: string; nameEn: string } | null;
    avatarUrl: string | null;
    groups: { id: string; name: string }[];
    card: 'ACTIVE' | 'NONE';
  };
  via: DeskMethod;
  now: string;
  timezone: string | null;
  classes: DeskClass[];
  makeupOptions: DeskClass[];
  action: DeskAction;
}

export interface CheckInResult {
  outcome: 'CHECKED_IN' | 'ALREADY' | 'NEEDS_DESK';
  record: {
    sessionId: string;
    status: AttendanceStatus;
    method: DeskMethod;
    checkedInAt: string | null;
    makeup: boolean;
  } | null;
  view: DeskView;
}

/** Who is at the desk: exactly one of these. */
export type DeskIdentity = { token: string } | { code: string } | { academyStudentId: string };

export interface CardState {
  active: { id: string; issuedAt: string } | null;
  history: {
    id: string;
    issuedAt: string;
    revokedAt: string | null;
    revokeReason: string | null;
  }[];
}

export interface IssuedCard {
  /** Shown once, to print. Never stored anywhere by this app. */
  token: string;
  card: { id: string; issuedAt: string };
  print: {
    fullName: string;
    code: string;
    grade: { nameAr: string; nameEn: string } | null;
    academy: { name: string; logoUrl: string | null };
  };
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic / Persian digits to 0-9, spaces and dashes dropped — as the server reads it. */
export function latinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  return out;
}

export const CARD_TOKEN_DIGITS = 48;

/**
 * What was typed or scanned into the desk box:
 *  - 48 digits → a card (QR camera or a USB scanner typing it);
 *  - 6 digits  → a student code;
 *  - another run of 16+ digits → a damaged or foreign scan: shown as an
 *    unknown card, and never sent to the register search (a card number must
 *    not end up in a query string);
 *  - anything else of 2+ characters → the C1 register search (name, phone).
 */
export type DeskInput =
  | { kind: 'TOKEN'; token: string }
  | { kind: 'CODE'; code: string }
  | { kind: 'BAD_SCAN' }
  | { kind: 'SEARCH'; q: string }
  | { kind: 'EMPTY' };

export function classifyDeskInput(raw: string): DeskInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'EMPTY' };
  const digits = latinDigits(trimmed).replace(/[\s-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length === CARD_TOKEN_DIGITS) return { kind: 'TOKEN', token: digits };
    if (digits.length === 6) return { kind: 'CODE', code: digits };
    if (digits.length >= 16) return { kind: 'BAD_SCAN' };
  }
  if (trimmed.length < 2) return { kind: 'EMPTY' };
  return { kind: 'SEARCH', q: trimmed };
}

/** True when a string looks like a scanned card: callers must never put it in a URL. */
export function looksLikeCard(raw: string): boolean {
  return /^\d{16,}$/.test(latinDigits(raw.trim()).replace(/[\s-]/g, ''));
}

export function useDeskAccess(academyId?: string) {
  return useQuery<DeskAccess>({
    queryKey: ['desk-access', academyId],
    queryFn: async () => (await api.get('/desk/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

/** Resolve who this is. Errors are shown by the desk itself (never a toast). */
export function useDeskResolve(academyId?: string) {
  return useMutation({
    mutationFn: async (who: DeskIdentity) =>
      (await api.post<DeskView>('/desk/resolve', who, { ...at(academyId), timeout: 15_000 })).data,
    // Offline must say so at once: never park the request until the network
    // returns (TanStack's default) and leave the desk on a spinner.
    networkMode: 'always',
    meta: { silentError: true },
  });
}

export function useDeskCheckIn(academyId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      v: DeskIdentity & {
        sessionId?: string;
        makeup?: boolean;
        homeGroupId?: string;
        makeupForSessionId?: string;
      },
    ) =>
      (await api.post<CheckInResult>('/desk/check-in', v, { ...at(academyId), timeout: 15_000 }))
        .data,
    onSuccess: () => {
      // Today's classes and class sheets now have one more mark.
      void qc.invalidateQueries({ queryKey: ['class-day'] });
      void qc.invalidateQueries({ queryKey: ['class-roster'] });
    },
    // Offline must say so at once: never park the request until the network
    // returns (TanStack's default) and leave the desk on a spinner.
    networkMode: 'always',
    meta: { silentError: true },
  });
}

export function useCardState(
  academyId: string | undefined,
  academyStudentId: string | undefined,
  enabled: boolean,
) {
  return useQuery<CardState>({
    queryKey: ['desk-card', academyId, academyStudentId],
    queryFn: async () => (await api.get(`/desk/cards/${academyStudentId}`, at(academyId))).data,
    enabled: !!academyId && !!academyStudentId && enabled,
  });
}

export function useCardActions(academyId: string | undefined, academyStudentId: string) {
  const qc = useQueryClient();
  const done = () =>
    void qc.invalidateQueries({ queryKey: ['desk-card', academyId, academyStudentId] });
  const base = `/desk/cards/${academyStudentId}`;
  return {
    issue: useMutation({
      mutationFn: async () => (await api.post<IssuedCard>(`${base}/issue`, {}, at(academyId))).data,
      onSuccess: done,
    }),
    reissue: useMutation({
      mutationFn: async (v: { cardId: string; reason?: string }) =>
        (await api.post<IssuedCard>(`${base}/reissue`, v, at(academyId))).data,
      onSuccess: done,
    }),
    revoke: useMutation({
      mutationFn: async (v: { cardId: string; reason: string }) =>
        (await api.post<CardState & { changed: boolean }>(`${base}/revoke`, v, at(academyId))).data,
      onSuccess: done,
    }),
  };
}

/** The API's error code, if the failure was an answer and not a lost connection. */
export function errorCode(e: unknown): string | null {
  return (e as { response?: { data?: { code?: string } } })?.response?.data?.code ?? null;
}

/** A request that never got an answer — offline, timeout, the server unreachable. */
export function isNetworkFailure(e: unknown): boolean {
  const err = e as { response?: unknown; code?: string };
  return !!e && !err.response;
}

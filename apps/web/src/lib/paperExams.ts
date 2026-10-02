import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Center Operations C6 — paper exams and grades.
 *
 * Marks travel as integer HUNDREDTHS (26.5 → 2650; at most two decimals),
 * never floats. 0 is a score; ABSENT and EXCUSED are not; a learner with no
 * row is ungraded. Statistics come from the server only (one implementation);
 * this file never averages anything.
 */

export type ExamKind = 'REGULAR' | 'MAKEUP';
export type ExamStatus = 'DRAFT' | 'PUBLISHED' | 'VOID';
export type ResultStatus = 'SCORED' | 'ABSENT' | 'EXCUSED';

export interface PaperExamsAccess {
  enabled: boolean;
  canView: boolean;
  canManage: boolean;
  canCorrect: boolean;
  canSettings: boolean;
  allGroups: boolean;
}

export interface ExamStats {
  examId: string;
  entered: number;
  scored: number;
  absent: number;
  excused: number;
  average: number | null;
  median: number | null;
  highest: number | null;
  lowest: number | null;
  passed: number | null;
  passRateBps: number | null;
}

export interface ExamView {
  id: string;
  groupId: string;
  groupSessionId: string | null;
  subjectId: string | null;
  title: string;
  note: string | null;
  examDate: string;
  maxScore: number;
  passScore: number | null;
  kind: ExamKind;
  makeupOfExamId: string | null;
  status: ExamStatus;
  publishedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  version: number;
}

export interface ExamListItem extends ExamView {
  groupName: string;
  stats: ExamStats | null;
}

export interface ResultView {
  status: ResultStatus;
  score: number | null;
  pctBps: number | null;
  passed: boolean | null;
  guest: boolean;
  version: number;
  corrected: boolean;
}

export interface SheetRow {
  academyStudentId: string;
  code: string;
  fullName: string;
  learnerStatus: string;
  expected: boolean;
  result: ResultView | null;
}

export interface Sheet {
  exam: ExamView & {
    groupName: string;
    makeupOf: { id: string; title: string; examDate: string } | null;
    makeups: { id: string; title: string; examDate: string; status: ExamStatus }[];
  };
  stats: ExamStats | null;
  progress: { graded: number; total: number };
  rows: SheetRow[];
}

export interface GradeHistoryItem {
  examId: string;
  title: string;
  examDate: string;
  groupId: string;
  groupName: string;
  kind: ExamKind;
  makeupOfExamId: string | null;
  maxScore: number;
  passScore: number | null;
  status: ResultStatus;
  score: number | null;
  guest: boolean;
  corrected: boolean;
  pctBps: number | null;
  passed: boolean | null;
}

export interface GradeSettings {
  lowGradePercent: number;
  guardianGradesVisible: boolean;
}

export interface RowInput {
  academyStudentId: string;
  status: ResultStatus | null;
  score?: number;
  version?: number;
  guest?: boolean;
}

export interface Conflict {
  academyStudentId: string;
  current: { status: ResultStatus; score: number | null; version: number } | null;
}

// ── Marks ────────────────────────────────────────────────────────────────

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const MAX_MARKS = 100_000;

/**
 * Typed marks → hundredths, or null if not a mark. "26", "26.5", "26.25",
 * "٢٦٫٥" (Arabic digits and decimal sign) all work; "0" is 0 (a real score).
 * More than two decimals, a sign, letters or anything above 1000.00 is
 * refused — never rounded. Pure string arithmetic.
 */
export function parseMarks(text: string): number | null {
  let s = '';
  for (const ch of text.trim()) {
    const a = AR_DIGITS.indexOf(ch);
    const f = FA_DIGITS.indexOf(ch);
    s += a >= 0 ? String(a) : f >= 0 ? String(f) : ch === '٫' || ch === ',' ? '.' : ch;
  }
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return h <= MAX_MARKS ? h : null;
}

/** Hundredths → the shortest exact text: 2650 → "26.5", 3000 → "30", 2625 → "26.25". */
export function formatMarks(h: number): string {
  const whole = Math.trunc(h / 100);
  const frac = h % 100;
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** Basis points → "88.33%". */
export function formatPct(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

/** A fresh identity for one user action — retries reuse it. */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// ── Hooks ────────────────────────────────────────────────────────────────

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

export function usePaperExamsAccess(academyId?: string) {
  return useQuery<PaperExamsAccess>({
    queryKey: ['pe-access', academyId],
    queryFn: async () => (await api.get('/paper-exams/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

/** Where paper exams are on for me — for the menu; never an error. */
export function useMyExamsAccess(enabled = true) {
  return useQuery<{ enabled: boolean; academies: { id: string; name: string; slug: string }[] }>({
    queryKey: ['pe-my-access'],
    queryFn: async () => (await api.get('/paper-exams/my-access')).data,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Which academy the exams pages act in: ?academy=, else the workspace being
 * used when exams are on there, else the first academy where they are on.
 */
export function useExamsAcademy(preferred: string | undefined) {
  const mine = useMyExamsAccess();
  const list = mine.data?.academies ?? [];
  const id = list.some((a) => a.id === preferred) ? preferred : list[0]?.id;
  return { loading: mine.isLoading, academies: list, academyId: id };
}

export function useExamGroups(academyId: string | undefined, enabled = true) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: ['pe-groups', academyId],
    queryFn: async () => (await api.get('/paper-exams/groups', at(academyId))).data,
    enabled: !!academyId && enabled,
    staleTime: 60_000,
  });
}

export function useExams(
  academyId: string | undefined,
  q: { groupId?: string; status?: ExamStatus; page: number },
  enabled = true,
) {
  return useQuery<{ total: number; page: number; pageSize: number; items: ExamListItem[] }>({
    queryKey: ['pe-list', academyId, q],
    queryFn: async () =>
      (
        await api.get('/paper-exams', {
          ...at(academyId),
          params: {
            ...(q.groupId ? { groupId: q.groupId } : {}),
            ...(q.status ? { status: q.status } : {}),
            page: q.page,
          },
        })
      ).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useSheet(academyId: string | undefined, id: string | undefined) {
  return useQuery<Sheet>({
    queryKey: ['pe-sheet', academyId, id],
    queryFn: async () => (await api.get(`/paper-exams/${id}`, at(academyId))).data,
    enabled: !!academyId && !!id,
    retry: false,
  });
}

export function useStudentGrades(
  academyId: string | undefined,
  studentId: string | undefined,
  enabled = true,
) {
  return useQuery<{ items: GradeHistoryItem[] }>({
    queryKey: ['pe-student', academyId, studentId],
    queryFn: async () =>
      (await api.get(`/paper-exams/by-student/${studentId}`, at(academyId))).data,
    enabled: !!academyId && !!studentId && enabled,
  });
}

export function useGradeSettings(academyId: string | undefined, enabled = true) {
  return useQuery<GradeSettings>({
    queryKey: ['pe-settings', academyId],
    queryFn: async () => (await api.get('/paper-exams/settings', at(academyId))).data,
    enabled: !!academyId && enabled,
  });
}

export async function downloadExamCsv(
  academyId: string,
  id: string,
): Promise<{ blob: Blob; filename: string }> {
  const r = await api.get(`/paper-exams/${id}/export`, { ...at(academyId), responseType: 'blob' });
  const cd = String(r.headers['content-disposition'] ?? '');
  return { blob: r.data as Blob, filename: /filename="([^"]+)"/.exec(cd)?.[1] ?? 'exam.csv' };
}

function useExamsInvalidate(academyId?: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of [
      'pe-list',
      'pe-sheet',
      'pe-student',
      'pe-settings',
      'fu-signals',
      'fu-timeline',
    ])
      void qc.invalidateQueries({ queryKey: [k, academyId] });
  };
}

export function usePaperExamActions(academyId: string | undefined) {
  const done = useExamsInvalidate(academyId);
  const cfg = at(academyId);
  return {
    create: useMutation({
      mutationFn: (v: {
        requestKey: string;
        groupId: string;
        title: string;
        examDate: string;
        maxScore: number;
        passScore?: number;
        groupSessionId?: string;
        subjectId?: string;
        note?: string;
      }) =>
        api.post<{ created: boolean; exam: ExamView }>('/paper-exams', v, cfg).then((r) => r.data),
      onSuccess: done,
      networkMode: 'always',
      meta: { silentError: true },
    }),
    makeup: useMutation({
      mutationFn: (v: { id: string; requestKey: string; examDate: string; title?: string }) => {
        const { id, ...body } = v;
        return api
          .post<{ created: boolean; exam: ExamView }>(`/paper-exams/${id}/makeups`, body, cfg)
          .then((r) => r.data);
      },
      onSuccess: done,
      networkMode: 'always',
      meta: { silentError: true },
    }),
    update: useMutation({
      mutationFn: (
        v: { id: string } & Partial<
          Pick<ExamView, 'title' | 'note' | 'examDate' | 'maxScore' | 'passScore'>
        >,
      ) => {
        const { id, ...body } = v;
        return api.patch<ExamView>(`/paper-exams/${id}`, body, cfg).then((r) => r.data);
      },
      onSuccess: done,
      meta: { silentError: true },
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/paper-exams/${id}`, cfg).then((r) => r.data),
      onSuccess: done,
    }),
    save: useMutation({
      mutationFn: (v: { id: string; requestKey: string; rows: RowInput[] }) =>
        api
          .put<{ replayed: boolean; saved: number; conflicts: Conflict[]; sheet: Sheet }>(
            `/paper-exams/${v.id}/results`,
            { requestKey: v.requestKey, rows: v.rows },
            cfg,
          )
          .then((r) => r.data),
      onSuccess: done,
      // Offline must say so; a retry reuses the same request key, so it is one save.
      networkMode: 'always',
      meta: { silentError: true },
    }),
    publish: useMutation({
      mutationFn: (id: string) =>
        api.post<ExamView>(`/paper-exams/${id}/publish`, {}, cfg).then((r) => r.data),
      onSuccess: done,
      onError: done,
      networkMode: 'always',
      meta: { silentError: true },
    }),
    correct: useMutation({
      mutationFn: (v: {
        id: string;
        academyStudentId: string;
        version: number;
        status: ResultStatus;
        score?: number;
        reason: string;
      }) => {
        const { id, academyStudentId, ...body } = v;
        return api
          .post(`/paper-exams/${id}/results/${academyStudentId}/correct`, body, cfg)
          .then((r) => r.data);
      },
      onSuccess: done,
      onError: done,
      networkMode: 'always',
      meta: { silentError: true },
    }),
    voidExam: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        api
          .post<ExamView>(`/paper-exams/${v.id}/void`, { reason: v.reason }, cfg)
          .then((r) => r.data),
      onSuccess: done,
      onError: done,
      meta: { silentError: true },
    }),
    updateSettings: useMutation({
      mutationFn: (v: Partial<GradeSettings>) =>
        api.patch<GradeSettings>('/paper-exams/settings', v, cfg).then((r) => r.data),
      onSuccess: done,
    }),
  };
}

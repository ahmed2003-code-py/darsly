import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useStaffAcademyStore } from '../stores/staffAcademy';
import { api } from './api';
import { useAssistantWorkspace } from './staff';
import type { SheetRow } from './studentSheet';

/**
 * The academy's student register (Center Operations C1) — the desk's data.
 *
 * Every call names the academy (X-Academy-Id) the way Student 360 does: the
 * one in the URL, else the academy an assistant works in, else the selected
 * workspace. The header only selects; the server decides from the membership,
 * the capability and the `studentRegistry` flag.
 */

export type RegistryStatus = 'ACTIVE' | 'WITHDRAWN';

export interface RegistryStudent {
  id: string;
  studentId: string;
  code: string;
  fullName: string;
  grade: { id: string; nameAr: string; nameEn: string } | null;
  studentPhone: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  school: string | null;
  status: RegistryStatus;
  source: 'DESK' | 'IMPORT' | 'ONLINE' | 'BACKFILL';
  joinedAt: string;
  leftAt: string | null;
  hasAccount: boolean;
  groups: { id: string; name: string }[];
}

export interface RegistryAccess {
  enabled: boolean;
  canView: boolean;
  canRegister: boolean;
}

export interface RegisterInput {
  fullName: string;
  gradeId?: string;
  studentPhone?: string;
  guardianName?: string;
  guardianPhone?: string;
  school?: string;
  groupId?: string;
  confirmDuplicate?: boolean;
}

export interface DuplicateCandidate {
  id: string;
  code: string;
  fullName: string;
  status: RegistryStatus;
  grade: string | null;
}

export interface ImportPreviewRow {
  row: number;
  status: 'OK' | 'WARNING' | 'ERROR' | 'DUPLICATE';
  issues: { field: string; code: string }[];
  data: {
    fullName: string;
    studentPhone: string | null;
    guardianName: string | null;
    guardianPhone: string | null;
    school: string | null;
    gradeName: string | null;
    groupName: string | null;
  };
  existing?: { code: string; fullName: string };
}

export interface ImportPreview {
  id: string;
  totalRows: number;
  validRows: number;
  counts: Record<ImportPreviewRow['status'], number>;
  alreadyImportedAt: string | null;
  rows: ImportPreviewRow[];
}

export interface ImportBatch {
  id: string;
  status: 'PREVIEWED' | 'COMMITTING' | 'COMMITTED';
  totalRows: number;
  validRows: number;
  createdCount: number;
  skippedCount: number;
  results: { row: number; status: 'CREATED' | 'SKIPPED'; code?: string; reason?: string }[] | null;
  committedAt: string | null;
}

/** "+201012345678" → "010 1234 5678": how a number is read and dialled. */
export function localPhone(e164: string | null): string {
  if (!e164) return '';
  const l = `0${e164.slice(3)}`;
  return `${l.slice(0, 3)} ${l.slice(3, 7)} ${l.slice(7)}`;
}

const at = (academyId?: string) => ({ headers: { 'X-Academy-Id': academyId ?? '' } });

/** A fresh identity for one user action — retries of that action reuse it. */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** Which academy the register pages act in (same resolution as Student 360). */
export function useRegistryAcademyId(): string | undefined {
  const [params] = useSearchParams();
  const ws = useAssistantWorkspace();
  const selected = useStaffAcademyStore((s) => s.academyId);
  return params.get('academy') ?? ws.academyId ?? selected ?? undefined;
}

/** For the menu and the pages: is the register on here, and what may I do. Never an error. */
export function useRegistryAccess(academyId?: string) {
  return useQuery<RegistryAccess>({
    queryKey: ['registry-access', academyId],
    queryFn: async () => (await api.get('/center-students/access', at(academyId))).data,
    enabled: !!academyId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useRegistryList(
  academyId: string | undefined,
  filter: { q: string; status: RegistryStatus | 'ALL'; page: number },
  enabled = true,
) {
  return useQuery<{ total: number; page: number; pageSize: number; items: RegistryStudent[] }>({
    queryKey: ['registry', academyId, filter.q, filter.status, filter.page],
    queryFn: async () =>
      (
        await api.get('/center-students', {
          ...at(academyId),
          params: {
            ...(filter.q ? { q: filter.q } : {}),
            status: filter.status,
            page: filter.page,
            pageSize: 25,
          },
        })
      ).data,
    enabled: !!academyId && enabled,
    placeholderData: keepPreviousData,
  });
}

/** Student 360: this academy's record behind a learner profile (null when not on the register). */
export function useRegistryRecord(
  academyId: string | undefined,
  studentId: string | undefined,
  enabled: boolean,
) {
  return useQuery<RegistryStudent | null>({
    queryKey: ['registry-record', academyId, studentId],
    queryFn: async () =>
      (await api.get(`/center-students/by-student/${studentId}`, at(academyId))).data.record,
    enabled: !!academyId && !!studentId && enabled,
  });
}

export function useRegistryGroups(academyId: string | undefined, enabled = true) {
  return useQuery<{ id: string; name: string; members: number }[]>({
    queryKey: ['registry-groups', academyId],
    queryFn: async () => (await api.get('/center-students/groups', at(academyId))).data,
    enabled: !!academyId && enabled,
    staleTime: 30_000,
  });
}

function useRegistryInvalidate(academyId?: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['registry', academyId] });
    qc.invalidateQueries({ queryKey: ['registry-record', academyId] });
    qc.invalidateQueries({ queryKey: ['registry-groups', academyId] });
    qc.invalidateQueries({ queryKey: ['staff-care', academyId] });
  };
}

/**
 * Register a learner. `requestKey` is made once per registration attempt by
 * the caller and sent again on a retry — so a double tap, or a retry after a
 * lost response, returns the same learner instead of creating two.
 */
export function useRegisterStudent(academyId?: string) {
  const done = useRegistryInvalidate(academyId);
  return useMutation({
    mutationFn: async (v: { requestKey: string; input: RegisterInput }) =>
      (
        await api.post<{ created: boolean; student: RegistryStudent }>(
          '/center-students',
          { requestKey: v.requestKey, ...v.input },
          at(academyId),
        )
      ).data,
    onSuccess: done,
    // The caller shows the duplicate warning and field errors itself.
    meta: { silentError: true },
  });
}

export function useUpdateStudent(academyId?: string) {
  const done = useRegistryInvalidate(academyId);
  return useMutation({
    mutationFn: async (v: {
      id: string;
      patch: Partial<Record<keyof RegisterInput, string | null>>;
    }) =>
      (await api.patch<RegistryStudent>(`/center-students/${v.id}`, v.patch, at(academyId))).data,
    onSuccess: done,
  });
}

export function useSetStudentStatus(academyId?: string) {
  const done = useRegistryInvalidate(academyId);
  return useMutation({
    mutationFn: async (v: { id: string; to: 'withdraw' | 'reactivate' }) =>
      (
        await api.post<{ changed: boolean; student: RegistryStudent }>(
          `/center-students/${v.id}/${v.to}`,
          {},
          at(academyId),
        )
      ).data,
    onSuccess: done,
  });
}

export function useAddStudentToGroup(academyId?: string) {
  const done = useRegistryInvalidate(academyId);
  return useMutation({
    mutationFn: async (v: { id: string; groupId: string }) =>
      (
        await api.post<{ added: boolean; student: RegistryStudent }>(
          `/center-students/${v.id}/groups`,
          { groupId: v.groupId },
          at(academyId),
        )
      ).data,
    onSuccess: done,
  });
}

export async function downloadRegistryCsv(academyId: string, status: RegistryStatus | 'ALL') {
  const res = await api.get('/center-students/export', {
    ...at(academyId),
    params: { status },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function usePreviewImport(academyId?: string) {
  return useMutation({
    mutationFn: async (v: { fileName: string; rows: SheetRow[] }) =>
      (await api.post<ImportPreview>('/center-students/import/preview', v, at(academyId))).data,
  });
}

/** Commit is safe to repeat: a retry of a batch already written just reports its outcome. */
export function useCommitImport(academyId?: string) {
  const done = useRegistryInvalidate(academyId);
  return useMutation({
    mutationFn: async (importId: string) =>
      (await api.post<ImportBatch>(`/center-students/import/${importId}/commit`, {}, at(academyId)))
        .data,
    onSuccess: done,
    meta: { silentError: true },
  });
}

export async function fetchImport(academyId: string, importId: string): Promise<ImportBatch> {
  return (await api.get(`/center-students/import/${importId}`, at(academyId))).data;
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AcademyRole } from '@darsly/shared-types';
import { api } from './api';
import {
  applyAdminTheme,
  DEFAULT_ADMIN_THEME,
  stripAdminThemeFromDom,
  type AdminThemeEntry,
} from './adminTheme';

// ── Theme ────────────────────────────────────────────────────────────────

export interface AdminThemePreference {
  themeId: string | null;
  /** Resolved by the API from whatever the id names — the only colours ever painted. */
  theme: AdminThemeEntry | null;
}

export interface AdminThemeCatalog {
  presets: AdminThemeEntry[];
  academies: AdminThemeEntry[];
  cosmetics: AdminThemeEntry[];
}

export function useAdminThemePreference(enabled: boolean) {
  return useQuery<AdminThemePreference>({
    queryKey: ['admin-theme'],
    queryFn: async () => (await api.get('/admin/theme')).data,
    enabled,
    staleTime: 60_000,
  });
}

/** Every look the console can wear: the presets, every Academy's brand, every store theme. */
export function useAdminThemeCatalog() {
  return useQuery<AdminThemeCatalog>({
    queryKey: ['admin-theme-catalog'],
    queryFn: async () => (await api.get('/admin/theme/catalog')).data,
    staleTime: 60_000,
  });
}

export function useSetAdminTheme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (themeId: string | null) =>
      (await api.patch<AdminThemePreference>('/admin/theme', { themeId })).data,
    onSuccess: (data) => qc.setQueryData(['admin-theme'], data),
  });
}

/**
 * Converges the live page with the server's record of this admin's theme
 * choice — the boot-time replay in main.tsx only runs once, before React
 * mounts, so it can't see a login that happened without a hard reload (the
 * common case: sign in, land on /admin, no refresh). This is what makes
 * that case still apply the right theme, and it's also what corrects a
 * stale/absent local cache against the real, server-persisted preference.
 */
export function useSyncAdminTheme(isSuperAdmin: boolean) {
  const { data } = useAdminThemePreference(isSuperAdmin);
  useEffect(() => {
    // A continuous invariant, not a one-time cleanup: whoever is NOT
    // SUPER_ADMIN right now never carries the admin look, however they got
    // here — a different account signing in on the same browser without a
    // hard reload, a session that started as admin and switched, etc.
    if (!isSuperAdmin) {
      stripAdminThemeFromDom();
      return;
    }
    if (!data) return;
    // No explicit choice yet → the platform default, not "undecorated".
    applyAdminTheme(data.theme ?? DEFAULT_ADMIN_THEME);
  }, [isSuperAdmin, data]);
}

// ── Academy staff management (Admin Studio reuses the owner-facing routes —
//    AcademyService.buildContext() already grants SUPER_ADMIN a full OWNER
//    AcademyContext for whichever academy the slug names) ──────────────────

export interface AdminAcademyMember {
  id: string;
  userId: string;
  role: AcademyRole;
  status: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
  joinedAt: string | null;
}

export function useAcademyMembers(slug: string | undefined) {
  return useQuery<AdminAcademyMember[]>({
    queryKey: ['admin-academy-members', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/members`)).data,
    enabled: !!slug,
  });
}

export function useAddAcademyMember(slug: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { email: string; role: 'TEACHER' | 'ASSISTANT' }) =>
      (await api.post(`/academies/${slug}/members`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-academy-members', slug] }),
  });
}

export function useUpdateAcademyMember(slug: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      membershipId,
      ...body
    }: {
      membershipId: string;
      role?: 'TEACHER' | 'ASSISTANT';
      status?: 'ACTIVE' | 'SUSPENDED';
    }) => (await api.patch(`/academies/${slug}/members/${membershipId}`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-academy-members', slug] }),
  });
}

export function useRemoveAcademyMember(slug: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (membershipId: string) =>
      (await api.delete(`/academies/${slug}/members/${membershipId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-academy-members', slug] }),
  });
}

// ── Academy activate/deactivate (reuses the existing teacher-status action —
//    Academy.status is fully DERIVED from TeacherProfile.status, never an
//    independently-settable field, so this is the only correct write path) ──

export function useSetAcademyActive(academyId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (active: boolean) =>
      (
        await api.patch(`/admin/teachers/${academyId}/status`, {
          status: active ? 'APPROVED' : 'SUSPENDED',
        })
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-academy-detail', academyId] });
      qc.invalidateQueries({ queryKey: ['admin-academies'] });
    },
  });
}

// ── Academy-scoped activity (reuses GET /admin/audit-logs with the new
//    academyId filter — not a second audit read path) ──────────────────────

export interface AuditLogRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  actor: { fullName: string; role: string } | null;
}

export function useAcademyActivity(academyId: string | undefined) {
  return useQuery<AuditLogRow[]>({
    queryKey: ['admin-academy-activity', academyId],
    queryFn: async () => (await api.get('/admin/audit-logs', { params: { academyId } })).data,
    enabled: !!academyId,
  });
}

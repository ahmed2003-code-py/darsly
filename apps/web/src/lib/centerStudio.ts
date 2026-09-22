import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminThemeEntry } from '@darsly/shared-types';
import { api } from './api';

export interface CenterThemeCatalog {
  academyId: string;
  slug: string;
  name: string;
  appliedThemeId: string | null;
  granted: string[];
  themes: (AdminThemeEntry & { granted: boolean })[];
}

export interface CenterStudioShelf {
  academyId: string;
  name: string;
  appliedThemeId: string | null;
  themes: AdminThemeEntry[];
}

/** The whole platform shelf, flagged with what this Center may wear. Admin only. */
export function useCenterThemeCatalog(academyId: string | undefined) {
  return useQuery<CenterThemeCatalog>({
    queryKey: ['admin-center-themes', academyId],
    queryFn: async () => (await api.get(`/admin/centers/${academyId}/themes`)).data,
    enabled: !!academyId,
  });
}

export function useSetCenterThemeGrants(academyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (themeIds: string[]) =>
      (await api.put(`/admin/centers/${academyId}/themes`, { themeIds })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-center-themes', academyId] });
    },
  });
}

/** The looks this Center was granted — the Center Studio's own shelf. */
export function useCenterStudioThemes(slug: string | undefined) {
  return useQuery<CenterStudioShelf>({
    queryKey: ['center-studio-themes', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/studio/themes`)).data,
    enabled: !!slug,
  });
}

export function useApplyCenterTheme(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (themeId: string) =>
      (await api.post(`/academies/${slug}/studio/themes/apply`, { themeId })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['center-studio-themes', slug] });
      // The console palette is derived from brandTokens on /me/academies —
      // without this the page would keep the previous look until a refresh.
      void qc.invalidateQueries({ queryKey: ['my-academies'] });
      void qc.invalidateQueries({ queryKey: ['academy-settings', slug] });
    },
  });
}

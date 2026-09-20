import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AcademyStatus } from '@darsly/shared-types';
import { api } from './api';

export interface AdminOverview {
  students: number;
  teachersApproved: number;
  teachersPending: number;
  coursesPublished: number;
  activeEnrollments: number;
  totalEnrollments: number;
  pendingPayouts: number;
  grossCents: number;
  commissionCents: number;
  totalAcademies: number;
  activeAcademies: number;
}

export interface AdminAcademyRow {
  id: string;
  slug: string;
  name: string;
  status: AcademyStatus;
  createdAt: string;
  ownerName: string;
  ownerEmail: string | null;
  teachersCount: number;
  assistantsCount: number;
  studentsCount: number;
  coursesCount: number;
  publishedCoursesCount: number;
  enrollmentsCount: number;
  netRevenueCents: number;
  platformFeeCents: number;
  lastActivityAt: string | null;
}

export interface AdminAcademyList {
  total: number;
  page: number;
  pageSize: number;
  academies: AdminAcademyRow[];
}

export interface AdminAcademyStaff {
  id: string;
  userId: string;
  role: 'OWNER' | 'TEACHER' | 'ASSISTANT';
  status: string;
  fullName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AdminAcademyDetail {
  id: string;
  slug: string;
  name: string;
  status: AcademyStatus;
  createdAt: string;
  language: string;
  currency: string;
  feeType: 'PERCENT' | 'FIXED';
  feeValue: number;
  owner: { id: string; fullName: string; email: string | null; phone: string | null };
  domains: { hostname: string; isPrimary: boolean; verifiedAt: string | null }[];
  staff: AdminAcademyStaff[];
  coursesCount: number;
  publishedCoursesCount: number;
  enrollmentsCount: number;
  studentsCount: number;
  netRevenueCents: number;
  platformFeeCents: number;
  lastActivityAt: string | null;
  featureFlags: { key: string; enabled: boolean }[];
}

export interface GrowthPoint {
  date: string;
  academies: number;
  students: number;
  enrollments: number;
}

export interface RevenuePoint {
  date: string;
  grossCents: number;
  feeCents: number;
}

export type GrowthRange = 7 | 30 | 90;

export function useAdminOverview() {
  return useQuery<AdminOverview>({
    queryKey: ['admin-overview'],
    queryFn: async () => (await api.get('/admin/overview')).data,
  });
}

export function useAdminAcademies(params: { search?: string; status?: AcademyStatus | ''; page?: number; pageSize?: number }) {
  return useQuery<AdminAcademyList>({
    queryKey: ['admin-academies', params],
    queryFn: async () =>
      (await api.get('/admin/academies', {
        params: {
          ...(params.search ? { search: params.search } : {}),
          ...(params.status ? { status: params.status } : {}),
          page: params.page ?? 1,
          pageSize: params.pageSize ?? 20,
        },
      })).data,
    placeholderData: (prev) => prev,
  });
}

export function useAdminAcademyDetail(id: string | undefined) {
  return useQuery<AdminAcademyDetail>({
    queryKey: ['admin-academy-detail', id],
    queryFn: async () => (await api.get(`/admin/academies/${id}`)).data,
    enabled: !!id,
  });
}

export function useAdminGrowthTrend(range: GrowthRange) {
  return useQuery<GrowthPoint[]>({
    queryKey: ['admin-growth-trend', range],
    queryFn: async () => (await api.get('/admin/analytics/growth', { params: { range } })).data,
  });
}

export function useAdminRevenueTrend(range: GrowthRange) {
  return useQuery<RevenuePoint[]>({
    queryKey: ['admin-revenue-trend', range],
    queryFn: async () => (await api.get('/admin/analytics/revenue', { params: { range } })).data,
  });
}

/** Feature flag admin API added in Phase 1 — the Academy Detail page is its
 *  first consumer. Enforcement stays server-side (FeatureFlagGuard); this is
 *  only the management surface. */
export function useSetFeatureFlag(academyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) =>
      (await api.patch(`/admin/academies/${academyId}/feature-flags/${key}`, { enabled })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-academy-detail', academyId] }),
  });
}

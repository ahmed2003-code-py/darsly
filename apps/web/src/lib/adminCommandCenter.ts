import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AcademyStatus, AcademyKind } from '@darsly/shared-types';
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
  kind: AcademyKind;
  createdAt: string;
  ownerName: string;
  ownerRole: string;
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
  kind: AcademyKind;
  createdAt: string;
  language: string;
  currency: string;
  feeType: 'PERCENT' | 'FIXED';
  feeValue: number;
  owner: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    role: string;
    isActive: boolean;
  };
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

export function useAdminAcademies(params: {
  search?: string;
  status?: AcademyStatus | '';
  kind?: AcademyKind;
  page?: number;
  pageSize?: number;
}) {
  return useQuery<AdminAcademyList>({
    queryKey: ['admin-academies', params],
    queryFn: async () =>
      (
        await api.get('/admin/academies', {
          params: {
            ...(params.search ? { search: params.search } : {}),
            ...(params.status ? { status: params.status } : {}),
            ...(params.kind ? { kind: params.kind } : {}),
            page: params.page ?? 1,
            pageSize: params.pageSize ?? 20,
          },
        })
      ).data,
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

// ── Centers (Architecture Reset, Phase 2) ───────────────────────────────────

export interface CreateCenterInput {
  name: string;
  slug?: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
  themeIds?: string[];
}
export interface CreateCenterResult {
  id: string;
  slug: string;
  name: string;
  status: AcademyStatus;
  kind: AcademyKind;
  admin: { id: string; role: string; activation: 'EMAIL_SENT' | 'EMAIL_FAILED' | 'NOT_REQUIRED' };
  /** Present for a new (email-activated) admin: whether the activation email was actually accepted for delivery. */
  delivery?: { delivered: true } | { delivered: false; reason: 'no-provider' | 'provider-error' };
  /** Present for a new (email-activated) admin: the one-time activation link, handed back to the SUPER_ADMIN who just minted it. */
  activationUrl?: string;
}

export function useCreateCenter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCenterInput) =>
      (await api.post<CreateCenterResult>('/admin/centers', input)).data,
    // The form marks each refused field itself; a toast on top would repeat it.
    meta: { silentError: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-academies'] });
    },
  });
}

export function useSetCenterStatus(academyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') =>
      (await api.patch(`/admin/centers/${academyId}/status`, { status })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-academy-detail', academyId] });
      void qc.invalidateQueries({ queryKey: ['admin-academies'] });
    },
  });
}

export interface ResendActivationResult {
  ok: true;
  expiresAt: string;
  delivery: { delivered: true } | { delivered: false; reason: 'no-provider' | 'provider-error' };
  activationUrl: string;
}

export function useResendCenterActivation(academyId: string) {
  return useMutation({
    mutationFn: async () =>
      (await api.post<ResendActivationResult>(`/admin/centers/${academyId}/activation/resend`))
        .data,
  });
}

export interface CenterDeletionImpact {
  id: string;
  slug: string;
  name: string;
  kind: 'PERSONAL' | 'CENTER';
  status: string;
  staffCount: number;
  studentCount: number;
  activeEnrollments: number;
  courseCount: number;
  groupCount: number;
  reversible: boolean;
}

/** What a delete would hide, fetched only while the confirmation is open — the
 *  admin decides with the numbers in front of them, not after. */
export function useCenterDeletionImpact(academyId: string | undefined, enabled: boolean) {
  return useQuery<CenterDeletionImpact>({
    queryKey: ['admin-center-deletion-impact', academyId],
    queryFn: async () => (await api.get(`/admin/centers/${academyId}/deletion-impact`)).data,
    enabled: !!academyId && enabled,
  });
}

export function useDeleteCenter(academyId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The address the admin typed travels in the body; see the controller for why.
    mutationFn: async (confirmSlug: string) =>
      (await api.delete(`/admin/centers/${academyId}`, { data: { confirmSlug } })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-academies'] });
      void qc.removeQueries({ queryKey: ['admin-academy-detail', academyId] });
    },
  });
}

export function useRevokeCenterAccess(academyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { userId: string; transferOwnershipTo?: string }) =>
      (await api.post(`/admin/centers/${academyId}/access/revoke`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-academy-detail', academyId] });
      void qc.invalidateQueries({ queryKey: ['admin-academy-members'] });
    },
  });
}

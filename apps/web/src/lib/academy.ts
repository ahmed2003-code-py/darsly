import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { api } from './api';
import type { AppTheme } from './theme';

/** Academy-first data hooks (Phase 4). Read-only, public where noted. */

/**
 * The look a teacher approved in Academy Studio, promoted to their brand. Every
 * field is optional at the type level because a document generated before the
 * design system existed simply will not have it.
 */
export interface BrandTokens {
  background?: string;
  ink?: string;
  surface?: string;
  radius?: number;
  density?: 'compact' | 'regular' | 'airy';
  headingScale?: 'restrained' | 'balanced' | 'dramatic';
  heroTreatment?: 'flat' | 'gradient' | 'mesh' | 'spotlight';
  bodyFont?: 'sans' | 'serif' | 'mono';
}

export interface AcademyBranding {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  status: string;
  logoUrl: string | null;
  coverUrl: string | null;
  colorPrimary: string;
  colorAccent: string;
  /** The design system published from Academy Studio, when there is one. */
  brandTokens?: BrandTokens | null;
  /** Derived console tokens, so the signed-out auth screens can wear them too. */
  appTheme?: AppTheme | null;
  language: string;
}

export interface AcademyCourseCard {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  priceCents: number;
  currency: string;
  pricingModel: string;
  status: string;
  subject: { nameAr: string; nameEn: string } | null;
  grade: { nameAr: string; nameEn: string } | null;
  teacherName: string | null;
  lessonsCount: number;
}

export interface MyAcademy {
  academyId: string;
  slug: string;
  name: string;
  role: string;
  isHome: boolean;
  status: string;
  branding: {
    logoUrl: string | null;
    colorPrimary: string;
    colorAccent: string;
    /** The design system published from Academy Studio, when there is one. */
    brandTokens?: BrandTokens | null;
    /**
     * The console's own token set, derived from the published palette by the
     * API — where the contrast floors are enforced. Applied wholesale by
     * `applyTheme`; the browser makes no colour decisions of its own.
     */
    appTheme?: AppTheme | null;
  };
}

/** Public academy branding by slug. */
export function useAcademyBranding(slug?: string) {
  return useQuery<AcademyBranding>({
    queryKey: ['academy', slug],
    queryFn: async () => (await api.get(`/academies/${slug}`)).data,
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
}

/** Public storefront: an academy's published courses. */
export function useAcademyCourses(slug?: string) {
  return useQuery<AcademyCourseCard[]>({
    queryKey: ['academy-courses', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/courses`)).data,
    enabled: !!slug,
  });
}

/** Academies the signed-in user belongs to (for the switcher / home). */
export function useMyAcademies() {
  // Gated on the token: the theme provider mounts above the router, so without
  // this the login screen would fire a request that can only ever be a 401.
  const token = useAuthStore((s) => s.accessToken);
  return useQuery<MyAcademy[]>({
    queryKey: ['my-academies'],
    queryFn: async () => (await api.get('/me/academies')).data,
    enabled: !!token,
  });
}

/** The academy the current user OWNS (for the console). */
export function useOwnedAcademy() {
  const q = useMyAcademies();
  return { ...q, academy: q.data?.find((a) => a.role === 'OWNER') };
}

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Academy-first data hooks (Phase 4). Read-only, public where noted. */

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
  branding: { logoUrl: string | null; colorPrimary: string; colorAccent: string };
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
  return useQuery<MyAcademy[]>({
    queryKey: ['my-academies'],
    queryFn: async () => (await api.get('/me/academies')).data,
  });
}

/** The academy the current user OWNS (for the console). */
export function useOwnedAcademy() {
  const q = useMyAcademies();
  return { ...q, academy: q.data?.find((a) => a.role === 'OWNER') };
}

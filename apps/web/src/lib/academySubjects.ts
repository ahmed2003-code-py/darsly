import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface AcademySubjectRow {
  id: string;
  code: string | null;
  nameAr: string;
  nameEn: string;
  icon: string | null;
  track: string;
  offered: boolean;
}
export interface AcademySubjects {
  gated: boolean;
  subjects: AcademySubjectRow[];
}

const key = (slug: string) => ['academy-subjects', slug];

export function useAcademySubjects(slug: string | undefined) {
  return useQuery<AcademySubjects>({
    queryKey: key(slug ?? ''),
    queryFn: async () => (await api.get(`/academies/${slug}/subjects`)).data,
    enabled: !!slug,
  });
}

export function useSetSubjectOffered(slug: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ subjectId, isActive }: { subjectId: string; isActive: boolean }) =>
      (await api.put(`/academies/${slug}/subjects/${subjectId}`, { isActive })).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key(slug ?? '') }); },
  });
}

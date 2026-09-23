import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface AcademySubjectRow {
  id: string;
  code: string | null;
  nameAr: string;
  nameEn: string;
  icon: string | null;
  track: string;
  /** Switched on for every Center without being asked. */
  isCore: boolean;
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

/**
 * One subject, switched over immediately.
 *
 * The tick used to wait for the round trip and then for a refetch of the whole
 * catalogue — two waits for a boolean, which read as the list being stuck. The
 * cache is written first and the server confirms behind it; a failure puts the
 * previous answer back, so the list never shows a state the server refused.
 */
export function useSetSubjectOffered(slug: string | undefined) {
  const qc = useQueryClient();
  const k = key(slug ?? '');
  return useMutation({
    mutationFn: async ({ subjectId, isActive }: { subjectId: string; isActive: boolean }) =>
      (await api.put(`/academies/${slug}/subjects/${subjectId}`, { isActive })).data,
    onMutate: async ({ subjectId, isActive }) => {
      await qc.cancelQueries({ queryKey: k });
      const previous = qc.getQueryData<AcademySubjects>(k);
      if (previous) {
        qc.setQueryData<AcademySubjects>(k, {
          ...previous,
          subjects: previous.subjects.map((s) =>
            s.id === subjectId ? { ...s, offered: isActive } : s,
          ),
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(k, ctx.previous);
    },
    // Deliberately no refetch on success: the answer is a boolean this client
    // just sent, and re-pulling forty rows per tick is what made it feel slow.
  });
}

/** The same answer for the whole catalogue — one request, then one refetch. */
export function useSetAllSubjectsOffered(slug: string | undefined) {
  const qc = useQueryClient();
  const k = key(slug ?? '');
  return useMutation({
    mutationFn: async (isActive: boolean) =>
      (await api.put(`/academies/${slug}/subjects`, { isActive })).data,
    onMutate: async (isActive) => {
      await qc.cancelQueries({ queryKey: k });
      const previous = qc.getQueryData<AcademySubjects>(k);
      if (previous) {
        qc.setQueryData<AcademySubjects>(k, {
          ...previous,
          subjects: previous.subjects.map((s) => ({ ...s, offered: isActive })),
        });
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(k, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: k });
    },
  });
}

/**
 * A subject the platform did not ship.
 *
 * The master catalogue is the platform's, so this is SUPER_ADMIN-only — but
 * the place it is wanted is right here, on the page where a Center owner has
 * just failed to find the subject they teach and the platform owner is
 * standing beside them.
 */
export function useCreateSubject(slug: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      nameAr: string;
      nameEn: string;
      icon?: string;
      track?: string;
      isCore?: boolean;
    }) => (await api.post('/catalog/subjects', body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(slug ?? '') });
      void qc.invalidateQueries({ queryKey: ['subjects'] });
    },
  });
}

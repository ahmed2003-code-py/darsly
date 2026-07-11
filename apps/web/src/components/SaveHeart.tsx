import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { Role } from '@darsly/shared-types';

/** Heart toggle to save/unsave a course to the student's wishlist. */
export default function SaveHeart({ courseId, className = '' }: { courseId: string; className?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const enabled = role === Role.STUDENT;

  const { data: ids } = useQuery({
    queryKey: ['saved-ids'],
    queryFn: async () => (await api.get('/me/saved/ids')).data as string[],
    enabled,
  });
  const saved = !!ids?.includes(courseId);

  const toggle = useMutation({
    mutationFn: async () =>
      saved ? api.delete(`/courses/${courseId}/save`) : api.post(`/courses/${courseId}/save`),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['saved-ids'] });
      const prev = qc.getQueryData<string[]>(['saved-ids']) ?? [];
      qc.setQueryData<string[]>(['saved-ids'], saved ? prev.filter((x) => x !== courseId) : [...prev, courseId]);
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(['saved-ids'], ctx.prev),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['saved-ids'] });
      qc.invalidateQueries({ queryKey: ['saved-courses'] });
    },
  });

  if (!enabled) return null;

  return (
    <button
      className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-bold transition ${
        saved ? 'border-error/40 bg-error-container/30 text-error' : 'border-outline-variant text-on-surface-variant hover:border-error/40 hover:text-error'
      } ${className}`}
      onClick={() => toggle.mutate()}
      title={saved ? t('saved.remove') : t('saved.add')}
    >
      <span className="material-symbols-outlined text-base" style={saved ? { fontVariationSettings: "'FILL' 1" } : undefined}>favorite</span>
      {saved ? t('saved.saved') : t('saved.save')}
    </button>
  );
}

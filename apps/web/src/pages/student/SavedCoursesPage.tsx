import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { CardGridSkeleton, EmptyState, PageHeader } from '../../components/ui';

export default function SavedCoursesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['saved-courses'],
    queryFn: async () => (await api.get('/me/saved')).data,
  });
  const unsave = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/courses/${id}/save`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-courses'] }),
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('saved.title')} subtitle={t('saved.subtitle')} />
      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState icon="favorite" title={t('saved.empty')} hint={t('saved.emptyHint')} />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((c: any) => (
            <div key={c.id} className="card card-hover flex flex-col overflow-hidden p-0">
              <Link to={`/course/${c.id}`} className="relative block h-40 bg-surface-container-high">
                {c.thumbnailUrl && <img src={c.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
                <button
                  className="absolute end-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-surface-container-lowest/90 text-error shadow-card backdrop-blur transition hover:scale-105"
                  onClick={(e) => { e.preventDefault(); unsave.mutate(c.id); }}
                  title={t('saved.remove')}
                >
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                </button>
              </Link>
              <div className="flex flex-1 flex-col p-5">
                <h3 className="mb-1 font-heading text-lg font-bold">{c.title}</h3>
                <p className="mb-3 text-sm text-primary">{c.teacherName}</p>
                <div className="mt-auto flex items-center justify-between text-sm">
                  <span className="text-outline">{c.subject}</span>
                  <span className="font-heading font-extrabold">{c.priceCents === 0 ? t('common.free') : egp(c.priceCents)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

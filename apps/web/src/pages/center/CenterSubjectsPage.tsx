import { useTranslation } from 'react-i18next';
import { useOwnedAcademy } from '../../lib/academy';
import { useAcademySubjects, useSetSubjectOffered } from '../../lib/academySubjects';
import { Badge, EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';

/** Which platform subjects this Center offers. Master subjects are never edited here — only switched on/off. */
export default function CenterSubjectsPage() {
  const { t, i18n } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  const { data, isLoading: loadingSubjects } = useAcademySubjects(academy?.slug);
  const set = useSetSubjectOffered(academy?.slug);
  const ar = i18n.language?.startsWith('ar');

  if (isLoading || loadingSubjects) return <div className="page"><Skeleton className="h-40 rounded-2xl" /></div>;
  if (!academy || !data) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;

  return (
    <div className="page">
      <PageHeader title={t('center.subjects')} subtitle={t('center.subjectsSub')} />
      <ErrorNote error={set.error} />
      <div className="card p-0">
        <ul className="divide-y divide-outline-variant">
          {data.subjects.map((s) => (
            <li key={s.id} className="flex items-center gap-3 p-4">
              <span className="material-symbols-outlined text-2xl text-primary">{s.icon ?? 'menu_book'}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{ar ? s.nameAr : s.nameEn}</p>
                <p className="truncate text-xs text-outline">{ar ? s.nameEn : s.nameAr}</p>
              </div>
              <Badge tone={s.offered ? 'teal' : 'neutral'}>{s.offered ? t('center.subjectOffered') : t('center.subjectNotOffered')}</Badge>
              {data.gated && (
                <button
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold ${s.offered ? 'border border-error/40 text-error hover:bg-error-container/40' : 'btn-primary'}`}
                  disabled={set.isPending}
                  onClick={() => set.mutate({ subjectId: s.id, isActive: !s.offered })}
                >
                  {s.offered ? t('center.subjectDisable') : t('center.subjectEnable')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

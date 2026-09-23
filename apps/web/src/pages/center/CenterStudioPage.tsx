import { useTranslation } from 'react-i18next';
import { ThemeApplyGrid } from '../../components/ThemeShelf';
import { useOwnedAcademy } from '../../lib/academy';
import { useApplyCenterTheme, useCenterStudioThemes } from '../../lib/centerStudio';
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';

/**
 * Center Studio — the looks a platform admin granted this organisation.
 *
 * Distinct from Academy Studio (which authors a public site) and from the
 * Admin Studio (which is the platform console's own look). The Center owner
 * picks from a short list; wearing one writes the same brand columns the
 * rest of the product already reads.
 */
export default function CenterStudioPage() {
  const { t } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  const slug = academy?.slug;
  const isCenter = academy?.kind === 'CENTER';
  const shelf = useCenterStudioThemes(isCenter ? slug : undefined);
  const apply = useApplyCenterTheme(slug ?? '');

  if (isLoading)
    return (
      <div className="page">
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  if (!academy || !isCenter) {
    return (
      <div className="page">
        <EmptyState icon="apartment" title={t('center.noCenter')} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={t('centerStudio.title')}
        subtitle={t('centerStudio.subtitle', { name: academy.name })}
      />
      {shelf.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-2xl" />
          ))}
        </div>
      ) : !shelf.data?.themes.length ? (
        <EmptyState
          icon="palette"
          title={t('centerStudio.empty')}
          hint={t('centerStudio.emptyHint')}
        />
      ) : (
        <ThemeApplyGrid
          themes={shelf.data.themes}
          appliedId={shelf.data.appliedThemeId}
          onApply={(id) => apply.mutate(id)}
          busy={apply.isPending}
        />
      )}
      <ErrorNote error={shelf.error ?? apply.error} />
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { useOwnedAcademy } from '../../lib/academy';
import { BrandingTab } from '../academy/AcademyConsolePage';
import { EmptyState, PageHeader, Skeleton } from '../../components/ui';

/** Center profile: the existing academy settings form (name, tagline, logo, cover, slug, colours).
 *  Kind and status are not in that form — they belong to the platform admin. */
export default function CenterSettingsPage() {
  const { t } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  if (isLoading) return <div className="page"><Skeleton className="h-32 rounded-2xl" /></div>;
  if (!academy) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;
  return (
    <div className="page">
      <PageHeader title={t('center.settings')} subtitle={academy.name} />
      <BrandingTab slug={academy.slug} />
    </div>
  );
}

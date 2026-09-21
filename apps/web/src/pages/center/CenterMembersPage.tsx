import { useTranslation } from 'react-i18next';
import { useOwnedAcademy } from '../../lib/academy';
import { MembersTab } from '../academy/AcademyConsolePage';
import { EmptyState, PageHeader, Skeleton } from '../../components/ui';

/** The existing members management, reached from the Center console. */
export default function CenterMembersPage() {
  const { t } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  if (isLoading) return <div className="page"><Skeleton className="h-32 rounded-2xl" /></div>;
  if (!academy) return <div className="page"><EmptyState icon="apartment" title={t('center.noCenter')} /></div>;
  return (
    <div className="page">
      <PageHeader title={t('center.members')} subtitle={academy.name} />
      <MembersTab slug={academy.slug} />
    </div>
  );
}

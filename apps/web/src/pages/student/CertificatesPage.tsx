import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { CardGridSkeleton, EmptyState, PageHeader } from '../../components/ui';
import { dateShort } from '../../lib/format';

export default function CertificatesPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['my-certificates'],
    queryFn: async () => (await api.get('/certificates/mine')).data,
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('cert.myTitle')} subtitle={t('cert.mySubtitle')} />
      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState icon="workspace_premium" title={t('cert.empty')} hint={t('cert.emptyHint')} />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((c: any) => (
            <Link key={c.id} to={`/certificate/${c.serial}`}
              className="card group relative overflow-hidden border-2 border-primary-container/60 bg-gradient-to-bl from-primary-fixed/50 to-surface-container-lowest transition hover:shadow-modal">
              <span className="material-symbols-outlined mb-2 text-4xl text-primary">workspace_premium</span>
              <h3 className="mb-1 font-heading text-lg font-extrabold">{c.course.title}</h3>
              <p className="text-sm text-on-surface-variant">{c.course.teacher.user.fullName}</p>
              <div className="mt-3 flex items-center justify-between text-xs text-outline">
                <span dir="ltr" className="font-mono">{c.serial}</span>
                <span>{dateShort(c.issuedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Badge, PageHeader, Spinner } from '../../components/ui';

const SEV_TONE: Record<string, 'error' | 'warn' | 'neutral'> = {
  CRITICAL: 'error', WARNING: 'warn', INFO: 'neutral',
};

export default function AdminSecurityPage() {
  const { t } = useTranslation();
  const { data: events, isLoading } = useQuery({
    queryKey: ['admin-security'],
    queryFn: async () => (await api.get('/admin/security-events')).data,
    refetchInterval: 30_000,
  });
  const { data: audit } = useQuery({
    queryKey: ['admin-audit'],
    queryFn: async () => (await api.get('/admin/audit-logs')).data,
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('admin.securityTitle')} subtitle={t('admin.securitySub')} />

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 font-heading text-xl font-extrabold">{t('admin.securityTitle')}</h2>
          {isLoading ? (
            <Spinner />
          ) : !events?.length ? (
            <div className="card py-10 text-center text-outline">
              <span className="material-symbols-outlined mb-2 text-4xl text-secondary">verified_user</span>
              <p>{t('admin.noEvents')}</p>
            </div>
          ) : (
            <div className="card p-0">
              <ul className="divide-y divide-outline-variant/40">
                {events.map((e: any) => (
                  <li key={e.id} className="flex items-center justify-between px-5 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-bold">
                        <Badge tone={SEV_TONE[e.severity]}>{e.severity}</Badge>
                        {t(`security.eventTypes.${e.type}`)}
                      </p>
                      <p className="mt-1 truncate text-xs text-outline">
                        {e.student?.user?.fullName ?? '—'}
                        {e.tenant?.user?.fullName ? ` · ${e.tenant.user.fullName}` : ''}
                      </p>
                    </div>
                    <span className="text-xs text-outline" dir="ltr">
                      {new Date(e.createdAt).toLocaleDateString('en-GB')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 font-heading text-xl font-extrabold">{t('admin.auditTitle')}</h2>
          <div className="card p-0">
            {!audit?.length ? (
              <p className="py-10 text-center text-outline">{t('admin.empty')}</p>
            ) : (
              <ul className="divide-y divide-outline-variant/40">
                {audit.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-primary">{a.action}</p>
                      <p className="truncate text-xs text-outline">
                        {a.actor?.fullName ?? 'system'} · {a.entity}
                      </p>
                    </div>
                    <span className="text-xs text-outline" dir="ltr">
                      {new Date(a.createdAt).toLocaleDateString('en-GB')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

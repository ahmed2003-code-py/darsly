import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { PageHeader, Skeleton } from '../../components/ui';

export default function AdminOverviewPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: async () => (await api.get('/admin/overview')).data,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const money = [
    { label: t('admin.gross'), value: egp(data.grossCents), icon: 'trending_up', tint: 'from-primary-container to-primary text-on-primary' },
    { label: t('admin.commission'), value: egp(data.commissionCents), icon: 'account_balance', tint: 'from-secondary-container to-secondary-fixed-dim text-on-secondary-container' },
  ];
  const counts = [
    { label: t('admin.students'), value: data.students, icon: 'school', to: undefined },
    { label: t('admin.teachers'), value: data.teachersApproved, icon: 'groups', to: '/admin/teachers' },
    { label: t('admin.pendingTeachers'), value: data.teachersPending, icon: 'pending_actions', to: '/admin/teachers?status=PENDING', highlight: data.teachersPending > 0 },
    { label: t('admin.courses'), value: data.coursesPublished, icon: 'menu_book' },
    { label: t('admin.activeEnrollments'), value: data.activeEnrollments, icon: 'workspace_premium' },
    { label: t('admin.pendingPayouts'), value: data.pendingPayouts, icon: 'payments', to: '/admin/payouts', highlight: data.pendingPayouts > 0 },
  ];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        {money.map((m) => (
          <div key={m.label} className={`card flex items-center gap-4 bg-gradient-to-br ${m.tint}`}>
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/25">
              <span className="material-symbols-outlined text-3xl">{m.icon}</span>
            </span>
            <div>
              <p className="text-sm opacity-90">{m.label}</p>
              <p className="font-heading text-3xl font-extrabold">{m.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {counts.map((c) => {
          const inner = (
            <div className={`card card-hover flex items-center gap-4 ${c.highlight ? 'ring-2 ring-primary' : ''}`}>
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-primary">
                <span className="material-symbols-outlined text-2xl">{c.icon}</span>
              </span>
              <div>
                <p className="font-heading text-2xl font-extrabold tabular-nums">{c.value}</p>
                <p className="text-sm text-on-surface-variant">{c.label}</p>
              </div>
            </div>
          );
          return c.to ? <Link key={c.label} to={c.to}>{inner}</Link> : <div key={c.label}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

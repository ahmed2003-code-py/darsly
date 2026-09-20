import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AcademyStatus } from '@darsly/shared-types';
import { dateShort, egp } from '../../lib/format';
import { useAdminAcademyDetail, useSetFeatureFlag } from '../../lib/adminCommandCenter';
import { Badge, ErrorNote, Skeleton } from '../../components/ui';

const TABS = ['overview', 'staff', 'flags'] as const;
type Tab = (typeof TABS)[number];

const TONE: Record<AcademyStatus, 'teal' | 'warn' | 'error' | 'neutral'> = {
  [AcademyStatus.ACTIVE]: 'teal',
  [AcademyStatus.PENDING]: 'warn',
  [AcademyStatus.SUSPENDED]: 'error',
  [AcademyStatus.ARCHIVED]: 'neutral',
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-4 text-center">
      <p className="font-heading text-2xl font-extrabold tabular-nums">{value}</p>
      <p className="text-xs text-on-surface-variant">{label}</p>
    </div>
  );
}

export default function AdminAcademyDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [tab, setTab] = useState<Tab>('overview');
  const { data, isLoading, error } = useAdminAcademyDetail(id);
  const setFlag = useSetFeatureFlag(id ?? '');

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton className="mb-6 h-24 rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="page">
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="page">
      <Link to="/admin/academies" className="mb-3 inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface">
        <span className="material-symbols-outlined text-lg">arrow_forward</span>
        {t('admin.backToAcademies')}
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-heading text-2xl font-extrabold">{data.name}</h1>
            <Badge tone={TONE[data.status]}>{t(`admin.academyStatus.${data.status}`)}</Badge>
          </div>
          <p className="text-sm text-outline" dir="ltr">{data.slug}</p>
        </div>
        <p className="text-sm text-on-surface-variant">
          {t('admin.createdOn', { date: dateShort(data.createdAt) })}
        </p>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.students')} value={data.studentsCount} />
        <Stat label={t('admin.staff')} value={data.staff.length} />
        <Stat label={t('admin.courses')} value={`${data.publishedCoursesCount} / ${data.coursesCount}`} />
        <Stat label={t('admin.totalEnrollments')} value={data.enrollmentsCount} />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div className="card flex items-center gap-4 p-5">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-2xl">payments</span>
          </span>
          <div>
            <p className="font-heading text-2xl font-extrabold tabular-nums">{egp(data.netRevenueCents)}</p>
            <p className="text-sm text-on-surface-variant">{t('admin.netRevenue')}</p>
          </div>
        </div>
        <div className="card flex items-center gap-4 p-5">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-2xl">account_balance</span>
          </span>
          <div>
            <p className="font-heading text-2xl font-extrabold tabular-nums">{egp(data.platformFeeCents)}</p>
            <p className="text-sm text-on-surface-variant">{t('admin.platformFee')}</p>
          </div>
        </div>
      </div>

      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setTab(tb)}
          >
            {t(`admin.academyTab.${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="card p-5">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-outline">{t('admin.owner')}</dt>
              <dd className="font-bold">{data.owner.fullName}</dd>
              <dd className="text-sm text-on-surface-variant" dir="ltr">{data.owner.email ?? data.owner.phone ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-outline">{t('admin.lastActivity')}</dt>
              <dd className="font-bold">{data.lastActivityAt ? dateShort(data.lastActivityAt) : t('admin.noActivityYet')}</dd>
            </div>
            <div>
              <dt className="text-xs text-outline">{t('admin.feePlan')}</dt>
              <dd className="font-bold">
                {data.feeType === 'PERCENT' ? `${data.feeValue}%` : egp(data.feeValue)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-outline">{t('admin.domains')}</dt>
              <dd className="font-bold">
                {data.domains.length
                  ? data.domains.map((d) => d.hostname).join(', ')
                  : t('admin.noCustomDomain')}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {tab === 'staff' && (
        <div className="grid gap-3">
          {data.staff.map((s) => (
            <div key={s.id} className="card flex items-center gap-4 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" /> : s.fullName?.trim()?.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{s.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">{s.email}</p>
              </div>
              <Badge tone={s.role === 'OWNER' ? 'primary' : 'neutral'}>{t(`admin.staffRole.${s.role}`)}</Badge>
            </div>
          ))}
        </div>
      )}

      {tab === 'flags' && (
        <div className="card divide-y divide-outline-variant/50 p-0">
          {data.featureFlags.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-heading font-bold">{t(`admin.featureFlag.${f.key}.label`)}</p>
                <p className="text-sm text-on-surface-variant">{t(`admin.featureFlag.${f.key}.hint`)}</p>
              </div>
              <button
                role="switch"
                aria-checked={f.enabled}
                disabled={setFlag.isPending}
                onClick={() => setFlag.mutate({ key: f.key, enabled: !f.enabled })}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${f.enabled ? 'bg-primary' : 'bg-outline-variant'}`}
              >
                <span
                  className="absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all"
                  style={{ insetInlineStart: f.enabled ? '1.625rem' : '0.25rem' }}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

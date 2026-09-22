import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router-dom';
import { AcademyKind, AcademyStatus } from '@darsly/shared-types';
import { dateShort, egp } from '../../lib/format';
import { useAdminAcademyDetail, useResendCenterActivation, useSetCenterStatus, useSetFeatureFlag } from '../../lib/adminCommandCenter';
import {
  useAcademyActivity,
  useAcademyMembers,
  useAddAcademyMember,
  useRemoveAcademyMember,
  useSetAcademyActive,
  useUpdateAcademyMember,
} from '../../lib/adminStudio';
import { Badge, ErrorNote, Field, Modal, Skeleton } from '../../components/ui';

const TABS = ['overview', 'staff', 'flags', 'activity'] as const;
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

function AddMemberModal({ open, onClose, slug }: { open: boolean; onClose: () => void; slug: string }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'TEACHER' | 'ASSISTANT'>('TEACHER');
  const add = useAddAcademyMember(slug);

  const submit = () => {
    add.mutate({ email: email.trim(), role }, { onSuccess: () => { setEmail(''); onClose(); } });
  };

  return (
    <Modal open={open} title={t('adminControlStudio.staff.addTitle')} onClose={onClose}>
      <Field label={t('adminControlStudio.staff.email')}>
        <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
      </Field>
      <Field label={t('adminControlStudio.staff.role')}>
        <select className="input w-full" value={role} onChange={(e) => setRole(e.target.value as 'TEACHER' | 'ASSISTANT')}>
          <option value="TEACHER">{t('admin.staffRole.TEACHER')}</option>
          <option value="ASSISTANT">{t('admin.staffRole.ASSISTANT')}</option>
        </select>
      </Field>
      <ErrorNote error={add.error} />
      <div className="flex justify-end gap-2">
        <button className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn-primary px-4 py-2 text-sm" disabled={!email.trim() || add.isPending} onClick={submit}>
          {t('adminControlStudio.staff.add')}
        </button>
      </div>
    </Modal>
  );
}

export default function AdminAcademyDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [tab, setTab] = useState<Tab>('overview');
  const [showAddMember, setShowAddMember] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const { data, isLoading, error } = useAdminAcademyDetail(id);
  const setFlag = useSetFeatureFlag(id ?? '');
  const members = useAcademyMembers(data?.slug);
  const updateMember = useUpdateAcademyMember(data?.slug);
  const removeMember = useRemoveAcademyMember(data?.slug);
  const setActive = useSetAcademyActive(id);
  const setCenterStatus = useSetCenterStatus(id!);
  const resendActivation = useResendCenterActivation(id!);
  const emailFailedOnCreate = new URLSearchParams(useLocation().search).get('activationEmail') === 'failed';
  const activity = useAcademyActivity(id);

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

  const isActive = data.status === AcademyStatus.ACTIVE;
  const canToggleStatus = data.status === AcademyStatus.ACTIVE || data.status === AcademyStatus.SUSPENDED;

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
        <div className="flex items-center gap-3">
          <p className="text-sm text-on-surface-variant">
            {t('admin.createdOn', { date: dateShort(data.createdAt) })}
          </p>
          {canToggleStatus && (
            <button
              className={`rounded-lg px-4 py-2 text-sm font-bold ${isActive ? 'border border-error/40 text-error hover:bg-error-container/40' : 'btn-primary'}`}
              onClick={() => setConfirmStatus(true)}
            >
              {isActive ? t('adminControlStudio.actions.suspendAcademy') : t('adminControlStudio.actions.reactivateAcademy')}
            </button>
          )}
        </div>
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
              <dt className="text-xs text-outline">{data.kind === AcademyKind.CENTER ? t('admin.centerAdmin') : t('admin.owner')}</dt>
              <dd className="font-bold">{data.owner.fullName}</dd>
              <dd className="text-sm text-on-surface-variant" dir="ltr">{data.owner.email ?? data.owner.phone ?? '—'}</dd>
              <dd className="mt-1 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{t(`admin.identity.${data.owner.role}`)}</Badge>
                {data.kind === AcademyKind.CENTER && !data.owner.isActive && (
                  <>
                    <Badge tone="warn">{t('admin.activationPending')}</Badge>
                    <button
                      className="text-xs font-bold text-primary hover:underline disabled:opacity-50"
                      disabled={resendActivation.isPending}
                      onClick={() => resendActivation.mutate()}
                    >
                      {resendActivation.isSuccess && (resendActivation.data as any)?.delivery?.delivered !== false ? t('admin.activationResent') : t('admin.resendActivation')}
                    </button>
                    {((resendActivation.isSuccess && (resendActivation.data as any)?.delivery?.delivered === false) || emailFailedOnCreate) && (
                      <span className="text-xs font-bold text-error">{t('admin.activationEmailFailed')}</span>
                    )}
                  </>
                )}
              </dd>
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
        <div>
          <div className="mb-4 flex justify-end">
            <button className="btn-primary px-4 py-2 text-sm" onClick={() => setShowAddMember(true)}>
              {t('adminControlStudio.staff.add')}
            </button>
          </div>
          <div className="grid gap-3">
            {(members.data ?? data.staff).map((s: any) => {
              const isOwner = s.role === 'OWNER';
              const isInvited = s.status === 'INVITED';
              return (
                <div key={s.id} className="card flex items-center gap-4 p-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                    {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" /> : s.fullName?.trim()?.charAt(0)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-heading font-bold">{s.fullName}</p>
                    <p className="truncate text-xs text-outline" dir="ltr">{s.email}</p>
                  </div>
                  {isInvited && <Badge tone="warn">{t('adminControlStudio.staff.invited')}</Badge>}
                  <Badge tone={isOwner ? 'primary' : s.status === 'SUSPENDED' ? 'error' : 'neutral'}>
                    {t(`admin.staffRole.${s.role}`)}
                  </Badge>
                  {!isOwner && s.id && members.data && (
                    <div className="flex items-center gap-1">
                      {!isInvited && (
                        <button
                          className="rounded-lg px-3 py-1.5 text-xs font-bold text-on-surface-variant hover:bg-surface-container-low"
                          disabled={updateMember.isPending}
                          onClick={() => updateMember.mutate({ membershipId: s.id, status: s.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' })}
                        >
                          {s.status === 'SUSPENDED' ? t('adminControlStudio.staff.reactivate') : t('adminControlStudio.staff.suspend')}
                        </button>
                      )}
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                        disabled={removeMember.isPending}
                        onClick={() => removeMember.mutate(s.id)}
                      >
                        {t('adminControlStudio.staff.remove')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <ErrorNote error={updateMember.error ?? removeMember.error} />
          {data.slug && <AddMemberModal open={showAddMember} onClose={() => setShowAddMember(false)} slug={data.slug} />}
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

      {tab === 'activity' && (
        <div className="card divide-y divide-outline-variant/50 p-0">
          {activity.isLoading ? (
            <div className="p-4"><Skeleton className="h-32 rounded-xl" /></div>
          ) : !activity.data?.length ? (
            <p className="p-8 text-center text-sm text-outline">{t('adminControlStudio.activity.empty')}</p>
          ) : (
            activity.data.map((row) => (
              <div key={row.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-heading text-sm font-bold" dir="ltr">{row.action}</p>
                  <p className="text-xs text-outline">{dateShort(row.createdAt)}</p>
                </div>
                <p className="text-xs text-on-surface-variant">
                  {row.actor?.fullName ?? t('adminControlStudio.activity.system')} · {row.entity}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      <Modal open={confirmStatus} title={isActive ? t('adminControlStudio.actions.suspendAcademy') : t('adminControlStudio.actions.reactivateAcademy')} onClose={() => setConfirmStatus(false)}>
        <p className="mb-4 text-sm text-on-surface-variant">
          {isActive ? t('adminControlStudio.actions.suspendConfirm', { name: data.name }) : t('adminControlStudio.actions.reactivateConfirm', { name: data.name })}
        </p>
        <ErrorNote error={data.kind === AcademyKind.CENTER ? setCenterStatus.error : setActive.error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary px-4 py-2 text-sm" onClick={() => setConfirmStatus(false)}>{t('common.cancel')}</button>
          <button
            className={isActive ? 'rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error' : 'btn-primary px-4 py-2 text-sm'}
            disabled={setActive.isPending || setCenterStatus.isPending}
            onClick={() =>
              data.kind === AcademyKind.CENTER
                ? setCenterStatus.mutate(isActive ? 'SUSPENDED' : 'ACTIVE', { onSuccess: () => setConfirmStatus(false) })
                : setActive.mutate(!isActive, { onSuccess: () => setConfirmStatus(false) })
            }
          >
            {isActive ? t('adminControlStudio.actions.suspendAcademy') : t('adminControlStudio.actions.reactivateAcademy')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

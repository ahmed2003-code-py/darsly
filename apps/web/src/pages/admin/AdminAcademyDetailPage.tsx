import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AcademyKind, AcademyStatus } from '@darsly/shared-types';
import { dateShort, egp } from '../../lib/format';
import {
  useAdminAcademyDetail,
  useCenterDeletionImpact,
  useDeleteCenter,
  useResendCenterActivation,
  useRevokeCenterAccess,
  useSetCenterStatus,
  useSetFeatureFlag,
} from '../../lib/adminCommandCenter';
import {
  useAcademyActivity,
  useAcademyMembers,
  useAddAcademyMember,
  useRemoveAcademyMember,
  useSetAcademyActive,
  useUpdateAcademyMember,
} from '../../lib/adminStudio';
import { Badge, ErrorNote, Field, Modal, Skeleton } from '../../components/ui';
import { CenterThemeGrantEditor } from './CenterThemeGrantPicker';
import { confirmDelete } from '../../lib/confirm';

const TABS_PERSONAL = ['overview', 'staff', 'flags', 'activity'] as const;
const TABS_CENTER = ['overview', 'staff', 'studio', 'flags', 'activity'] as const;
type Tab = (typeof TABS_CENTER)[number];

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

function AddMemberModal({
  open,
  onClose,
  slug,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'TEACHER' | 'ASSISTANT'>('TEACHER');
  const add = useAddAcademyMember(slug);

  const submit = () => {
    add.mutate(
      { email: email.trim(), role },
      {
        onSuccess: () => {
          setEmail('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} title={t('adminControlStudio.staff.addTitle')} onClose={onClose}>
      <Field label={t('adminControlStudio.staff.email')}>
        <input
          className="input w-full"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
        />
      </Field>
      <Field label={t('adminControlStudio.staff.role')}>
        <select
          className="input w-full"
          value={role}
          onChange={(e) => setRole(e.target.value as 'TEACHER' | 'ASSISTANT')}
        >
          <option value="TEACHER">{t('admin.staffRole.TEACHER')}</option>
          <option value="ASSISTANT">{t('admin.staffRole.ASSISTANT')}</option>
        </select>
      </Field>
      <ErrorNote error={add.error} />
      <div className="flex justify-end gap-2">
        <button className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn-primary px-4 py-2 text-sm"
          disabled={!email.trim() || add.isPending}
          onClick={submit}
        >
          {t('adminControlStudio.staff.add')}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Removing an organisation, and removing one person from it.
 *
 * Kept behind its own heading and away from the ordinary controls above: a
 * delete here hides a Center with everything hanging off it, and "suspend" a
 * click away is the reversible thing an admin usually wants instead. The counts
 * are fetched while the confirmation is open so the decision is made with the
 * scale of it visible, and the address has to be typed back — a boolean
 * confirmation is satisfied by a mis-click on the wrong row.
 */
function DangerZone({
  academyId,
  slug,
  name,
  status,
  kind,
}: {
  academyId: string;
  slug: string;
  name: string;
  status: AcademyStatus;
  kind: AcademyKind;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const impact = useCenterDeletionImpact(academyId, open);
  const remove = useDeleteCenter(academyId);
  const setCenterStatus = useSetCenterStatus(academyId);

  const isCenter = kind === AcademyKind.CENTER;
  const matches = typed.trim().toLowerCase() === slug.toLowerCase();

  return (
    <div className="mt-6 rounded-xl border border-error/30 p-5">
      <h3 className="font-heading font-bold text-error">{t('admin.danger.title')}</h3>
      <p className="mt-1 text-sm text-on-surface-variant">{t('admin.danger.hint')}</p>

      <div className="mt-4 grid gap-3">
        {isCenter && status !== AcademyStatus.ARCHIVED && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-container-low p-3">
            <div>
              <p className="font-bold">{t('admin.danger.archive')}</p>
              <p className="text-sm text-on-surface-variant">{t('admin.danger.archiveHint')}</p>
            </div>
            <button
              className="rounded-lg border border-outline px-4 py-2 text-sm font-bold"
              disabled={setCenterStatus.isPending}
              onClick={() => setCenterStatus.mutate(AcademyStatus.ARCHIVED)}
            >
              {t('admin.danger.archive')}
            </button>
          </div>
        )}

        {isCenter && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-error-container/40 p-3">
            <div>
              <p className="font-bold text-error">{t('admin.danger.delete')}</p>
              <p className="text-sm text-on-surface-variant">{t('admin.danger.deleteHint')}</p>
            </div>
            <button
              className="rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error"
              onClick={() => {
                setTyped('');
                setOpen(true);
              }}
            >
              {t('admin.danger.delete')}
            </button>
          </div>
        )}
        {!isCenter && (
          <p className="text-sm text-on-surface-variant">{t('admin.danger.personalOnly')}</p>
        )}
      </div>

      <Modal
        open={open}
        title={t('admin.danger.deleteTitle', { name })}
        onClose={() => setOpen(false)}
      >
        <p className="mb-3 text-sm text-on-surface-variant">{t('admin.danger.deleteBody')}</p>
        {impact.isLoading ? (
          <Skeleton className="mb-4 h-20 rounded-xl" />
        ) : impact.data ? (
          <ul className="mb-4 grid gap-1 rounded-xl bg-surface-container-low p-3 text-sm">
            <li>{t('admin.danger.impactStaff', { count: impact.data.staffCount })}</li>
            <li>{t('admin.danger.impactStudents', { count: impact.data.studentCount })}</li>
            <li>{t('admin.danger.impactCourses', { count: impact.data.courseCount })}</li>
            <li>{t('admin.danger.impactGroups', { count: impact.data.groupCount })}</li>
            {impact.data.activeEnrollments > 0 && (
              <li className="font-bold text-error">
                {t('admin.danger.impactActive', { count: impact.data.activeEnrollments })}
              </li>
            )}
          </ul>
        ) : null}
        <Field label={t('admin.danger.confirmLabel', { slug })}>
          <input
            className="input w-full"
            dir="ltr"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={slug}
          />
        </Field>
        <ErrorNote error={remove.error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary px-4 py-2 text-sm" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </button>
          <button
            className="rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error disabled:opacity-40"
            disabled={!matches || remove.isPending}
            onClick={() =>
              remove.mutate(typed.trim(), { onSuccess: () => navigate('/admin/academies') })
            }
          >
            {remove.isPending ? t('common.saving') : t('admin.danger.deleteConfirm')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Revoking the Center admin's own access.
 *
 * Separate from the ordinary "remove member" because it is the one removal that
 * cannot leave the Center as it found it: with the owner gone nobody can grant
 * access to anybody, so a successor is named in the same breath and the two
 * happen together or not at all.
 */
function RevokeOwnerModal({
  open,
  onClose,
  academyId,
  owner,
  staff,
}: {
  open: boolean;
  onClose: () => void;
  academyId: string;
  owner: { id: string; fullName: string };
  staff: { userId: string; fullName: string; status: string }[];
}) {
  const { t } = useTranslation();
  const [successor, setSuccessor] = useState('');
  const revoke = useRevokeCenterAccess(academyId);
  // Only someone who could hold the Center tomorrow: active staff, and not the
  // person being revoked. The API enforces the same rule; this keeps the list
  // from offering a choice it would then refuse.
  const candidates = staff.filter((m) => m.userId !== owner.id && m.status === 'ACTIVE');

  return (
    <Modal open={open} title={t('admin.revokeOwner.title')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">
        {t('admin.revokeOwner.body', { name: owner.fullName })}
      </p>
      {candidates.length === 0 ? (
        <p className="mb-4 rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container">
          {t('admin.revokeOwner.noCandidates')}
        </p>
      ) : (
        <Field label={t('admin.revokeOwner.successor')}>
          <select
            className="input w-full"
            value={successor}
            onChange={(e) => setSuccessor(e.target.value)}
          >
            <option value="">{t('admin.revokeOwner.pick')}</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.fullName}
              </option>
            ))}
          </select>
        </Field>
      )}
      <ErrorNote error={revoke.error} />
      <div className="flex justify-end gap-2">
        <button className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error disabled:opacity-40"
          disabled={!successor || revoke.isPending}
          onClick={() =>
            revoke.mutate(
              { userId: owner.id, transferOwnershipTo: successor },
              { onSuccess: onClose },
            )
          }
        >
          {t('admin.revokeOwner.confirm')}
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
  const [revokeOwner, setRevokeOwner] = useState(false);
  const { data, isLoading, error } = useAdminAcademyDetail(id);
  const setFlag = useSetFeatureFlag(id ?? '');
  const members = useAcademyMembers(data?.slug);
  const updateMember = useUpdateAcademyMember(data?.slug);
  const removeMember = useRemoveAcademyMember(data?.slug);
  const setActive = useSetAcademyActive(id);
  const setCenterStatus = useSetCenterStatus(id!);
  const resendActivation = useResendCenterActivation(id!);
  const searchParams = new URLSearchParams(useLocation().search);
  const emailFailedOnCreate = searchParams.get('activationEmail') === 'failed';
  // Shown once, right after creation — carried in the URL, not persisted or
  // re-fetchable. A resend mints a fresh one (in resendActivation.data), so
  // losing this copy is never a dead end: hit "resend activation" again.
  const [activationLink, setActivationLink] = useState<string | null>(
    searchParams.get('activationLink'),
  );
  const [linkCopied, setLinkCopied] = useState(false);
  const copyActivationLink = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
  };
  const activity = useAcademyActivity(id);

  if (isLoading) {
    return (
      <div className="page">
        <Skeleton className="mb-6 h-24 rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
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
  const isCenter = data.kind === AcademyKind.CENTER;
  /**
   * A PENDING Center used to show no lifecycle control at all — which is how a
   * Center created with the wrong address, whose admin never opened the
   * activation email, became permanently unmanageable: not active, so nothing
   * to suspend, and there was no delete. Suspending a PENDING Center is a
   * legitimate call the API already accepted (only PENDING → ACTIVE is refused,
   * because activation happens through the emailed link), so the button belongs
   * here too. ARCHIVED stays out: it is reversed from the danger zone below.
   */
  const canToggleStatus =
    isActive ||
    data.status === AcademyStatus.SUSPENDED ||
    (isCenter && data.status === AcademyStatus.PENDING);

  return (
    <div className="page">
      <Link
        to="/admin/academies"
        className="mb-3 inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface"
      >
        <span className="material-symbols-outlined text-lg">arrow_forward</span>
        {t('admin.backToAcademies')}
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-heading text-2xl font-extrabold">{data.name}</h1>
            <Badge tone={TONE[data.status]}>{t(`admin.academyStatus.${data.status}`)}</Badge>
          </div>
          <p className="text-sm text-outline" dir="ltr">
            {data.slug}
          </p>
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
              {isActive
                ? t('adminControlStudio.actions.suspendAcademy')
                : t('adminControlStudio.actions.reactivateAcademy')}
            </button>
          )}
        </div>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.students')} value={data.studentsCount} />
        <Stat label={t('admin.staff')} value={data.staff.length} />
        <Stat
          label={t('admin.courses')}
          value={`${data.publishedCoursesCount} / ${data.coursesCount}`}
        />
        <Stat label={t('admin.totalEnrollments')} value={data.enrollmentsCount} />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div className="card flex items-center gap-4 p-5">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-2xl">payments</span>
          </span>
          <div>
            <p className="font-heading text-2xl font-extrabold tabular-nums">
              {egp(data.netRevenueCents)}
            </p>
            <p className="text-sm text-on-surface-variant">{t('admin.netRevenue')}</p>
          </div>
        </div>
        <div className="card flex items-center gap-4 p-5">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-2xl">account_balance</span>
          </span>
          <div>
            <p className="font-heading text-2xl font-extrabold tabular-nums">
              {egp(data.platformFeeCents)}
            </p>
            <p className="text-sm text-on-surface-variant">{t('admin.platformFee')}</p>
          </div>
        </div>
      </div>

      <div className="mb-6 flex gap-2">
        {(isCenter ? TABS_CENTER : TABS_PERSONAL).map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
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
              <dt className="text-xs text-outline">
                {data.kind === AcademyKind.CENTER ? t('admin.centerAdmin') : t('admin.owner')}
              </dt>
              <dd className="font-bold">{data.owner.fullName}</dd>
              <dd className="text-sm text-on-surface-variant" dir="ltr">
                {data.owner.email ?? data.owner.phone ?? '—'}
              </dd>
              <dd className="mt-1 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{t(`admin.identity.${data.owner.role}`)}</Badge>
                {data.kind === AcademyKind.CENTER && !data.owner.isActive && (
                  <>
                    <Badge tone="warn">{t('admin.activationPending')}</Badge>
                    <button
                      className="text-xs font-bold text-primary hover:underline disabled:opacity-50"
                      disabled={resendActivation.isPending}
                      onClick={() =>
                        resendActivation.mutate(undefined, {
                          onSuccess: (res) => setActivationLink(res.activationUrl),
                        })
                      }
                    >
                      {resendActivation.isSuccess &&
                      resendActivation.data.delivery.delivered !== false
                        ? t('admin.activationResent')
                        : t('admin.resendActivation')}
                    </button>
                    {((resendActivation.isSuccess &&
                      resendActivation.data.delivery.delivered === false) ||
                      emailFailedOnCreate) && (
                      <span className="text-xs font-bold text-error">
                        {t('admin.activationEmailFailed')}
                      </span>
                    )}
                  </>
                )}
              </dd>
              {data.kind === AcademyKind.CENTER && !data.owner.isActive && activationLink && (
                <dd className="mt-2 flex items-center gap-2 rounded-xl bg-surface-container-low p-2">
                  <span className="material-symbols-outlined text-lg text-primary">link</span>
                  <input
                    className="input flex-1 truncate border-0 bg-transparent px-1 py-1 text-xs"
                    dir="ltr"
                    readOnly
                    value={activationLink}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                    onClick={() => copyActivationLink(activationLink)}
                  >
                    {linkCopied ? t('common.copied') : t('common.copyLink')}
                  </button>
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-outline">{t('admin.lastActivity')}</dt>
              <dd className="font-bold">
                {data.lastActivityAt ? dateShort(data.lastActivityAt) : t('admin.noActivityYet')}
              </dd>
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
          <DangerZone
            academyId={data.id}
            slug={data.slug}
            name={data.name}
            status={data.status}
            kind={data.kind}
          />
        </div>
      )}

      {tab === 'studio' && isCenter && (
        <div className="card p-5">
          <CenterThemeGrantEditor academyId={data.id} />
        </div>
      )}

      {tab === 'staff' && (
        <div>
          <div className="mb-4 flex justify-end">
            <button
              className="btn-primary px-4 py-2 text-sm"
              onClick={() => setShowAddMember(true)}
            >
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
                    {s.avatarUrl ? (
                      <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      s.fullName?.trim()?.charAt(0)
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-heading font-bold">{s.fullName}</p>
                    <p className="truncate text-xs text-outline" dir="ltr">
                      {s.email}
                    </p>
                  </div>
                  {isInvited && <Badge tone="warn">{t('adminControlStudio.staff.invited')}</Badge>}
                  <Badge
                    tone={isOwner ? 'primary' : s.status === 'SUSPENDED' ? 'error' : 'neutral'}
                  >
                    {t(`admin.staffRole.${s.role}`)}
                  </Badge>
                  {/* The owner's access is revocable only by a platform admin,
                      and only together with a successor — hence its own action
                      rather than the plain "remove" the others get. */}
                  {isOwner && isCenter && (
                    <button
                      className="rounded-lg px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                      onClick={() => setRevokeOwner(true)}
                    >
                      {t('admin.revokeOwner.action')}
                    </button>
                  )}
                  {!isOwner && s.id && members.data && (
                    <div className="flex items-center gap-1">
                      {!isInvited && (
                        <button
                          className="rounded-lg px-3 py-1.5 text-xs font-bold text-on-surface-variant hover:bg-surface-container-low"
                          disabled={updateMember.isPending}
                          onClick={() =>
                            updateMember.mutate({
                              membershipId: s.id,
                              status: s.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED',
                            })
                          }
                        >
                          {s.status === 'SUSPENDED'
                            ? t('adminControlStudio.staff.reactivate')
                            : t('adminControlStudio.staff.suspend')}
                        </button>
                      )}
                      <button
                        className="rounded-lg px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                        disabled={removeMember.isPending}
                        onClick={async () =>
                          (await confirmDelete({
                            kind: 'remove',
                            name: s.fullName ?? s.user?.fullName,
                          })) && removeMember.mutate(s.id)
                        }
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
          {data.slug && (
            <AddMemberModal
              open={showAddMember}
              onClose={() => setShowAddMember(false)}
              slug={data.slug}
            />
          )}
          <RevokeOwnerModal
            open={revokeOwner}
            onClose={() => setRevokeOwner(false)}
            academyId={data.id}
            owner={{ id: data.owner.id, fullName: data.owner.fullName }}
            staff={(members.data ?? []).map((m) => ({
              userId: m.userId,
              fullName: m.fullName,
              status: m.status,
            }))}
          />
        </div>
      )}

      {tab === 'flags' && (
        <div className="card divide-y divide-outline-variant/50 p-0">
          {data.featureFlags.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-heading font-bold">{t(`admin.featureFlag.${f.key}.label`)}</p>
                <p className="text-sm text-on-surface-variant">
                  {t(`admin.featureFlag.${f.key}.hint`)}
                </p>
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
            <div className="p-4">
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : !activity.data?.length ? (
            <p className="p-8 text-center text-sm text-outline">
              {t('adminControlStudio.activity.empty')}
            </p>
          ) : (
            activity.data.map((row) => (
              <div key={row.id} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-heading text-sm font-bold" dir="ltr">
                    {row.action}
                  </p>
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

      <Modal
        open={confirmStatus}
        title={
          isActive
            ? t('adminControlStudio.actions.suspendAcademy')
            : t('adminControlStudio.actions.reactivateAcademy')
        }
        onClose={() => setConfirmStatus(false)}
      >
        <p className="mb-4 text-sm text-on-surface-variant">
          {isActive
            ? t('adminControlStudio.actions.suspendConfirm', { name: data.name })
            : t('adminControlStudio.actions.reactivateConfirm', { name: data.name })}
        </p>
        <ErrorNote
          error={data.kind === AcademyKind.CENTER ? setCenterStatus.error : setActive.error}
        />
        <div className="flex justify-end gap-2">
          <button
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => setConfirmStatus(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            className={
              isActive
                ? 'rounded-lg bg-error px-4 py-2 text-sm font-bold text-on-error'
                : 'btn-primary px-4 py-2 text-sm'
            }
            disabled={setActive.isPending || setCenterStatus.isPending}
            onClick={() =>
              data.kind === AcademyKind.CENTER
                ? setCenterStatus.mutate(isActive ? 'SUSPENDED' : 'ACTIVE', {
                    onSuccess: () => setConfirmStatus(false),
                  })
                : setActive.mutate(!isActive, { onSuccess: () => setConfirmStatus(false) })
            }
          >
            {isActive
              ? t('adminControlStudio.actions.suspendAcademy')
              : t('adminControlStudio.actions.reactivateAcademy')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

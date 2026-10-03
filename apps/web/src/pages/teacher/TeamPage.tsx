import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Avatar from '../../components/Avatar';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Skeleton,
} from '../../components/ui';
import { useOwnedAcademy } from '../../lib/academy';
import { useRegistryAccess } from '../../lib/centerStudents';
import { useDeskAccess } from '../../lib/desk';
import { useFeesAccess } from '../../lib/centerFees';
import { useFollowUpAccess } from '../../lib/followUp';
import { usePaperExamsAccess } from '../../lib/paperExams';
import { useDailyAccess } from '../../lib/dailyOps';
import { useSettlementAccess } from '../../lib/settlements';
import { useStaffAcademyStore } from '../../stores/staffAcademy';
import { askConfirm } from '../../lib/confirm';
import { dateShort } from '../../lib/format';
import { invitationJoinUrl } from '../../lib/invitationLinks';
import {
  AssistantGrant,
  CAPABILITY_GROUPS,
  OFFERED,
  PRESETS,
  PresetKey,
  presetOf,
  ACADEMY_WIDE_GROUPS,
  DESK_ONLY_GROUPS,
  DESK_ONLY_PRESETS,
  FEES_ONLY_GROUPS,
  FOLLOWUP_ONLY_GROUPS,
  GRADES_ONLY_GROUPS,
  DAILY_ONLY_GROUPS,
  SETTLEMENT_ONLY_GROUPS,
  REGISTRY_ONLY_GROUPS,
  REGISTRY_ONLY_PRESETS,
  TeamAssistant,
  useAssistantLinks,
  useInviteAssistant,
  useMemberStatus,
  useRevokeAssistantLink,
  useSaveAssistant,
  useTeam,
  useTeamCourses,
} from '../../lib/team';

/**
 * Team — the owner's assistants.
 *
 * An assistant is a person with their own account who helps with some of the
 * academy's students. The owner decides three things for each, in plain words:
 * which courses, what they may do, and whether students can start a chat with
 * them. Presets fill those in; what is saved is always the three answers.
 */
export default function TeamPage() {
  const { t } = useTranslation();
  const { academy, isLoading: loadingAcademy } = useOwnedAcademy();
  const slug = academy?.slug;
  const team = useTeam(slug);
  const links = useAssistantLinks(slug);
  const [editing, setEditing] = useState<TeamAssistant | 'new' | null>(null);
  const pending = (links.data ?? []).filter((l) => l.status === 'PENDING');

  if (!loadingAcademy && !academy) {
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('team.ownerOnly')} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={t('team.title')}
        subtitle={t('team.subtitle')}
        action={
          <button className="btn-primary" onClick={() => setEditing('new')} disabled={!slug}>
            <span className="material-symbols-outlined text-[20px]">person_add</span>
            {t('team.add')}
          </button>
        }
      />

      {team.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : team.error ? (
        <ErrorNote error={team.error} />
      ) : !team.data?.length && !pending.length ? (
        <EmptyState icon="support_agent" title={t('team.empty')} hint={t('team.emptyHint')} />
      ) : (
        <ul className="space-y-3">
          {team.data?.map((a) => (
            <AssistantCard key={a.membershipId} a={a} slug={slug!} onEdit={() => setEditing(a)} />
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-heading text-lg font-bold text-on-surface">
            {t('team.pending')}
          </h2>
          <ul className="space-y-2">
            {pending.map((l) => (
              <PendingLink key={l.id} link={l} slug={slug!} />
            ))}
          </ul>
        </section>
      )}

      {editing && slug && (
        <AssistantEditor
          slug={slug}
          assistant={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function capsSummary(permissions: string[], t: (k: string) => string) {
  return permissions.filter((p) => OFFERED.has(p)).map((p) => t(`team.cap.${p}.short`));
}

function AssistantCard({
  a,
  slug,
  onEdit,
}: {
  a: TeamAssistant;
  slug: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const status = useMemberStatus(slug);
  const caps = capsSummary(a.permissions, t);
  const suspended = a.status === 'SUSPENDED';
  return (
    <li className="card flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 gap-3">
        <Avatar id={a.userId} name={a.name} url={a.avatarUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <bdi className="truncate font-heading font-bold text-on-surface">{a.name}</bdi>
            {a.title && <Badge>{a.title}</Badge>}
            {suspended && <Badge tone="warn">{t('team.suspended')}</Badge>}
          </div>
          <p className="mt-0.5 truncate text-sm text-on-surface-variant" dir="auto">
            {a.email ?? a.phone}
          </p>
          <dl className="mt-3 grid gap-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="shrink-0 text-on-surface-variant">{t('team.courses')}:</dt>
              <dd className="min-w-0 text-on-surface">
                {a.courseScope === 'ALL'
                  ? t('team.allCourses')
                  : a.courses.length
                    ? a.courses.map((c) => c.title).join('، ')
                    : t('team.noCourses')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-on-surface-variant">{t('team.can')}:</dt>
              <dd className="min-w-0 text-on-surface">
                {caps.length ? caps.join(' · ') : t('team.nothingYet')}
              </dd>
            </div>
            <div className="flex items-center gap-1.5 text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px]">
                {a.directContact ? 'forum' : 'speaker_notes_off'}
              </span>
              {a.directContact ? t('team.directOn') : t('team.directOff')}
            </div>
          </dl>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <button className="btn-secondary" onClick={onEdit}>
          <span className="material-symbols-outlined text-[18px]">tune</span>
          {t('team.edit')}
        </button>
        <button
          className="btn-ghost"
          disabled={status.isPending}
          onClick={() =>
            status.mutate({
              membershipId: a.membershipId,
              action: suspended ? 'ACTIVE' : 'SUSPENDED',
            })
          }
        >
          {suspended ? t('team.reactivate') : t('team.suspend')}
        </button>
        <button
          className="btn-ghost text-error"
          disabled={status.isPending}
          onClick={async () => {
            if (await askConfirm(t('team.removeConfirm', { name: a.name })))
              status.mutate({ membershipId: a.membershipId, action: 'REMOVE' });
          }}
        >
          {t('team.remove')}
        </button>
      </div>
    </li>
  );
}

function PendingLink({
  link,
  slug,
}: {
  link: { id: string; expiresAt: string; grant: AssistantGrant | null };
  slug: string;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeAssistantLink(slug);
  return (
    <li className="card flex items-center gap-3 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
        <span className="material-symbols-outlined text-[20px]">link</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-on-surface">
          {link.grant?.title || t('team.assistant')}
        </p>
        <p className="text-xs text-on-surface-variant">
          {t('team.expires', { date: dateShort(link.expiresAt) })}
        </p>
      </div>
      <button
        className="btn-ghost"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate(link.id)}
      >
        {t('team.revoke')}
      </button>
    </li>
  );
}

function AssistantEditor({
  slug,
  assistant,
  onClose,
}: {
  slug: string;
  assistant: TeamAssistant | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const courses = useTeamCourses(slug);
  const save = useSaveAssistant(slug);
  const invite = useInviteAssistant(slug);
  const [grant, setGrant] = useState<AssistantGrant>(() =>
    assistant
      ? {
          title: assistant.title ?? '',
          permissions: assistant.permissions,
          courseScope: assistant.courseScope,
          courseIds: assistant.courses.map((c) => c.id),
          directContact: assistant.directContact,
        }
      : {
          title: t('team.preset.support.title'),
          permissions: [...PRESETS.support.permissions],
          courseScope: 'SELECTED',
          courseIds: [],
          directContact: PRESETS.support.directContact,
        },
  );
  // The register's preset and capabilities are offered only where it is on.
  const selectedAcademy = useStaffAcademyStore((s) => s.academyId) ?? undefined;
  const registryOn = !!useRegistryAccess(selectedAcademy).data?.enabled;
  // …and the desk's (C3) where the desk is on, and fees (C4) where they are on.
  const deskOn = !!useDeskAccess(selectedAcademy).data?.enabled;
  const feesOn = !!useFeesAccess(selectedAcademy).data?.enabled;
  // …and student follow-up (C5) where it is on.
  const followUpOn = !!useFollowUpAccess(selectedAcademy).data?.enabled;
  // …and paper exams (C6) where they are on.
  const gradesOn = !!usePaperExamsAccess(selectedAcademy).data?.enabled;
  // …and the day's operations (C7) where they are on.
  const dailyOn = !!useDailyAccess(selectedAcademy).data?.enabled;
  // …and teacher settlements (C8) where they are on.
  const settlementOn = !!useSettlementAccess(selectedAcademy).data?.enabled;
  const groupShown = (key: string) =>
    (registryOn || !REGISTRY_ONLY_GROUPS.has(key)) &&
    (deskOn || !DESK_ONLY_GROUPS.has(key)) &&
    (feesOn || !FEES_ONLY_GROUPS.has(key)) &&
    (followUpOn || !FOLLOWUP_ONLY_GROUPS.has(key)) &&
    (gradesOn || !GRADES_ONLY_GROUPS.has(key)) &&
    (dailyOn || !DAILY_ONLY_GROUPS.has(key)) &&
    (settlementOn || !SETTLEMENT_ONLY_GROUPS.has(key));
  /** Capabilities of a feature that is off here: never granted by a preset, ignored when matching one. */
  const hidden = useMemo(
    () => new Set(CAPABILITY_GROUPS.filter((g) => !groupShown(g.key)).flatMap((g) => g.caps)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registryOn, deskOn, feesOn, followUpOn, gradesOn, dailyOn, settlementOn],
  );
  const preset = useMemo(
    () => presetOf(grant.permissions, grant.directContact, hidden),
    [grant, hidden],
  );
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const has = (c: string) => grant.permissions.includes(c);
  const toggle = (c: string) =>
    setGrant((g) => {
      const permissions = g.permissions.includes(c)
        ? g.permissions.filter((p) => p !== c)
        : [...g.permissions, c];
      // Nobody can start a chat with someone who cannot answer it.
      return {
        ...g,
        permissions,
        directContact: permissions.includes('message.reply') && g.directContact,
      };
    });
  const applyPreset = (k: PresetKey) => {
    if (k === 'custom') return;
    const p = PRESETS[k];
    setGrant((g) => ({
      ...g,
      // Keep a title the owner typed; replace one that was a preset's name.
      title:
        !g.title || Object.keys(PRESETS).some((pk) => t(`team.preset.${pk}.title`) === g.title)
          ? t(`team.preset.${k}.title`)
          : g.title,
      // Anything outside the screen (an older assistant's grant) is carried as is.
      permissions: [
        ...g.permissions.filter((x) => !OFFERED.has(x)),
        ...p.permissions.filter((x) => !hidden.has(x)),
      ],
      directContact: p.directContact,
      // The register is the whole academy's: it is never granted course by course.
      ...(k === 'reception' || k === 'frontDesk'
        ? { courseScope: 'ALL' as const, courseIds: [] }
        : {}),
    }));
  };
  const noCourses = grant.courseScope === 'SELECTED' && !grant.courseIds.length;
  const error = save.error ?? invite.error;

  const submit = async () => {
    const body = { ...grant, title: grant.title.trim() };
    if (assistant) {
      await save.mutateAsync({ membershipId: assistant.membershipId, grant: body });
      onClose();
    } else {
      const link = await invite.mutateAsync(body);
      setCreated(invitationJoinUrl(link.token));
    }
  };

  if (created) {
    const message = t('team.shareText', { url: created });
    return (
      <Modal open title={t('team.linkReady')} onClose={onClose}>
        <p className="mb-3 text-sm text-on-surface-variant">{t('team.linkReadyHint')}</p>
        <div className="mb-4 flex items-center gap-2 rounded-sm border border-outline-variant/60 bg-surface-container-low p-2">
          <code className="min-w-0 flex-1 truncate text-xs" dir="ltr">
            {created}
          </code>
          <button
            className="btn-secondary shrink-0"
            onClick={() =>
              void navigator.clipboard?.writeText(created).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            <span className="material-symbols-outlined text-[18px]">
              {copied ? 'check' : 'content_copy'}
            </span>
            {copied ? t('team.copied') : t('team.copy')}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="btn-primary"
            href={`https://wa.me/?text=${encodeURIComponent(message)}`}
            target="_blank"
            rel="noreferrer"
          >
            <span className="material-symbols-outlined text-[20px]">share</span>
            {t('team.shareWhatsapp')}
          </a>
          <button className="btn-ghost" onClick={onClose}>
            {t('team.done')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      wide
      title={assistant ? t('team.editTitle', { name: assistant.name }) : t('team.addTitle')}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit().catch(() => undefined);
        }}
      >
        {/* 1. A starting point */}
        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-semibold text-on-surface-variant">
            {t('team.startFrom')}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                'support',
                'academic',
                'operations',
                'reception',
                'frontDesk',
                'custom',
              ] as PresetKey[]
            )
              .filter((k) => registryOn || !REGISTRY_ONLY_PRESETS.has(k))
              .filter((k) => deskOn || !DESK_ONLY_PRESETS.has(k))
              .map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={preset === k}
                  onClick={() => applyPreset(k)}
                  className={`rounded-sm border p-3 text-start transition ${
                    preset === k
                      ? 'border-primary bg-primary-fixed/50'
                      : 'border-outline-variant/60 hover:bg-surface-container-low'
                  } ${k === 'custom' ? 'cursor-default' : ''}`}
                >
                  <span className="block font-bold text-on-surface">
                    {t(`team.preset.${k}.title`)}
                  </span>
                  <span className="block text-xs text-on-surface-variant">
                    {/* Where fees are on, the desk preset also takes money — say so. */}
                    {k === 'frontDesk' && feesOn
                      ? t('team.preset.frontDesk.hintFees')
                      : t(`team.preset.${k}.hint`)}
                  </span>
                </button>
              ))}
          </div>
        </fieldset>

        {/* 2. What students see */}
        <Field label={t('team.titleLabel')} hint={t('team.titleHint')} id="assistant-title">
          <input
            id="assistant-title"
            className="input"
            value={grant.title}
            maxLength={40}
            required
            onChange={(e) => setGrant((g) => ({ ...g, title: e.target.value }))}
          />
        </Field>

        {/* 3. Which courses */}
        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-semibold text-on-surface-variant">
            {t('team.whichCourses')}
          </legend>
          <div className="flex flex-col gap-2">
            {(['SELECTED', 'ALL'] as const).map((scope) => (
              <label key={scope} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  className="mt-1"
                  checked={grant.courseScope === scope}
                  onChange={() => setGrant((g) => ({ ...g, courseScope: scope }))}
                />
                <span>
                  <span className="block font-medium text-on-surface">
                    {t(`team.scope.${scope}`)}
                  </span>
                  <span className="block text-xs text-on-surface-variant">
                    {t(`team.scope.${scope}Hint`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {grant.courseScope === 'SELECTED' && (
            <div className="mt-3 max-h-56 overflow-y-auto rounded-sm border border-outline-variant/60 p-2">
              {courses.isLoading ? (
                <Skeleton className="h-10" />
              ) : !courses.data?.length ? (
                <p className="p-2 text-sm text-on-surface-variant">{t('team.noCoursesYet')}</p>
              ) : (
                courses.data.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-surface-container-low"
                  >
                    <input
                      type="checkbox"
                      checked={grant.courseIds.includes(c.id)}
                      onChange={() =>
                        setGrant((g) => ({
                          ...g,
                          courseIds: g.courseIds.includes(c.id)
                            ? g.courseIds.filter((x) => x !== c.id)
                            : [...g.courseIds, c.id],
                        }))
                      }
                    />
                    <bdi className="min-w-0 flex-1 truncate text-on-surface">{c.title}</bdi>
                    {c.status !== 'PUBLISHED' && (
                      <Badge tone="neutral">{t(`team.courseStatus.${c.status}`, c.status)}</Badge>
                    )}
                  </label>
                ))
              )}
            </div>
          )}
          {noCourses && (
            <p className="mt-2 text-sm text-on-surface-variant">{t('team.pickACourse')}</p>
          )}
        </fieldset>

        {/* 4. What they can do */}
        <fieldset className="mb-5">
          <legend className="mb-2 text-sm font-semibold text-on-surface-variant">
            {t('team.whatCanTheyDo')}
          </legend>
          <div className="flex flex-col gap-4">
            {CAPABILITY_GROUPS.filter((g) => groupShown(g.key)).map((group) => (
              <div key={group.key}>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-outline">
                  {t(`team.group.${group.key}`)}
                </p>
                {ACADEMY_WIDE_GROUPS.has(group.key) && grant.courseScope === 'SELECTED' && (
                  <p className="mb-1 text-xs text-on-surface-variant">
                    {t('team.registerNeedsAll')}
                  </p>
                )}
                {group.caps.map((c) => (
                  <label
                    key={c}
                    className={`flex items-start gap-2 py-1 text-sm ${ACADEMY_WIDE_GROUPS.has(group.key) && grant.courseScope === 'SELECTED' ? 'opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={has(c)}
                      disabled={
                        ACADEMY_WIDE_GROUPS.has(group.key) && grant.courseScope === 'SELECTED'
                      }
                      onChange={() => toggle(c)}
                    />
                    <span>
                      <span className="block text-on-surface">{t(`team.cap.${c}.label`)}</span>
                      <span className="block text-xs text-on-surface-variant">
                        {t(`team.cap.${c}.hint`)}
                      </span>
                    </span>
                  </label>
                ))}
                {group.key === 'messages' && (
                  <label
                    className={`flex items-start gap-2 py-1 text-sm ${has('message.reply') ? '' : 'opacity-50'}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!has('message.reply')}
                      checked={grant.directContact}
                      onChange={() => setGrant((g) => ({ ...g, directContact: !g.directContact }))}
                    />
                    <span>
                      <span className="block text-on-surface">{t('team.direct.label')}</span>
                      <span className="block text-xs text-on-surface-variant">
                        {t('team.direct.hint')}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            ))}
          </div>
        </fieldset>

        {error && <ErrorNote error={error} />}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={save.isPending || invite.isPending || !grant.title.trim()}
          >
            {assistant ? t('team.save') : t('team.createLink')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

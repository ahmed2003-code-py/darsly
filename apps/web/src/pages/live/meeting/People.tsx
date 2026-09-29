import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { askConfirm } from '../../../lib/confirm';
import type { Participant } from '../../../lib/useDailyMeeting';
import type { LiveMeeting } from '../../../lib/useLiveMeeting';

type Cf = Extract<LiveMeeting, { provider: 'cloudflare' }>;
type Hand = NonNullable<Cf['rtc']>['participants'][number]['hand'];

/**
 * The class, as a list: who has a hand up, who is speaking, who is here,
 * and — for whoever runs the class — who holds a seat and has not come.
 *
 * Every row stays compact (initial, name, a few state icons); what a
 * moderator can do to someone lives behind one "⋯" button: a small menu
 * beside the row on a wide screen, a bottom sheet on a phone so the video
 * stays in view. The server decides every action again — this list only
 * draws what the room state says.
 */

export interface RowAction {
  key: string;
  icon: string;
  label: string;
  tone?: 'primary' | 'danger';
  /** Shown but not available, with the reason under it. */
  disabledReason?: string;
  run: () => void | Promise<void>;
}

/** Extra actions per student row, contributed by later features (invite, bonus, camera…). */
export type ExtraActions = (p: { userId: string; name: string; hand: Hand; guest?: boolean }) => RowAction[];

function GroupTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 mt-4 text-xs font-bold text-on-surface-variant first:mt-0">{children}</h3>;
}

function StateIcon({ icon, label, tone }: { icon: string; label: string; tone?: 'on' | 'off' | 'warn' }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`material-symbols-outlined text-[18px] ${
        tone === 'on' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-300' : 'text-outline'
      }`}
    >
      {icon}
    </span>
  );
}

/** The "⋯" menu: beside the row on sm+, a bottom sheet on a phone. */
function ActionsMenu({ name, actions }: { name: string; actions: RowAction[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!actions.length) return null;
  return (
    <div ref={ref} className="relative" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('meeting.actionsFor', { name })}
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 place-items-center rounded-full text-on-surface-variant hover:bg-on-surface/10 hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span aria-hidden className="material-symbols-outlined text-[20px]">
          more_horiz
        </span>
      </button>
      {open && (
        <>
          <div aria-hidden className="fixed inset-0 z-40 bg-black/40 sm:hidden" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={t('meeting.actionsFor', { name })}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl bg-surface-container-high p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:end-0 sm:top-full sm:mt-1 sm:w-60 sm:rounded-2xl"
          >
            <p className="truncate px-3 pb-1 pt-2 text-xs font-bold text-on-surface-variant sm:hidden" dir="auto">
              {name}
            </p>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                disabled={!!a.disabledReason}
                aria-disabled={!!a.disabledReason}
                onClick={() => {
                  setOpen(false);
                  void a.run();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start text-sm font-semibold hover:bg-on-surface/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent sm:py-2 ${
                  a.tone === 'danger' ? 'text-red-300' : a.tone === 'primary' ? 'text-primary' : 'text-on-surface'
                }`}
              >
                <span aria-hidden className="material-symbols-outlined text-[20px]">
                  {a.icon}
                </span>
                <span className="min-w-0">
                  <span className="block">{a.label}</span>
                  {a.disabledReason && (
                    <span className="block text-xs font-normal text-on-surface-variant">{a.disabledReason}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  name,
  sub,
  icons,
  actions,
  children,
}: {
  name: string;
  sub?: ReactNode;
  icons?: ReactNode;
  actions?: RowAction[];
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span
        aria-hidden
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-container-highest text-sm font-bold"
      >
        {name.trim().charAt(0) || '؟'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" dir="auto">
          {name}
        </span>
        {sub && <span className="block text-xs text-on-surface-variant">{sub}</span>}
      </span>
      {icons && <span className="flex shrink-0 items-center gap-1">{icons}</span>}
      {children}
      {actions && <ActionsMenu name={name} actions={actions} />}
    </li>
  );
}

export default function People({
  moderator,
  meeting,
  cf,
  extraActions,
  badges,
  onBonus,
}: {
  moderator: boolean;
  meeting: LiveMeeting;
  cf: Cf | null;
  /** More actions for a student's menu (later features add theirs here). */
  extraActions?: ExtraActions;
  /** Small per-person badges beside the icons (a bonus total…). */
  badges?: (userId: string) => ReactNode;
  /** Opens the bonus dialog for a student. */
  onBonus?: (p: { userId: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const handOf = new Map((cf?.rtc?.participants ?? []).map((p) => [p.userId, p.hand]));
  const hands = cf?.hands ?? [];
  const raised = hands.filter((h) => h.hand === 'HAND_RAISED');
  const speaking = hands.filter((h) => h.hand === 'APPROVED_TO_SPEAK' || h.hand === 'ACTIVE_SPEAKER');
  const handIds = new Set([...raised, ...speaking].map((h) => h.userId));
  const rest = meeting.participants
    .filter((p) => !p.userId || !handIds.has(p.userId))
    .sort((a, b) => Number(b.owner) - Number(a.owner));
  const notJoined = moderator ? (cf?.rtc?.notJoined ?? []) : [];
  const controlsOf = new Map((cf?.rtc?.participants ?? []).map((p) => [p.userId, p.controls]));
  const rtcOf = new Map((cf?.rtc?.participants ?? []).map((p) => [p.userId, p]));
  const micBlocked = (userId: string) => controlsOf.get(userId)?.mic === 'BLOCKED';

  const remove = async (userId: string, name: string, sessionId: string) => {
    if (
      await askConfirm(t('meeting.removeConfirm', { name }), {
        danger: true,
        confirmLabel: t('meeting.removeOne'),
      })
    )
      meeting.removeParticipant(cf ? userId : sessionId);
  };

  /** A student's menu, for a moderator: what applies to their state now. */
  const actionsFor = (p: { userId: string; name: string; sessionId: string }): RowAction[] => {
    if (!moderator) return [];
    const hand = (handOf.get(p.userId) ?? 'IDLE') as Hand;
    const out: RowAction[] = [];
    if (cf && hand === 'HAND_RAISED') {
      out.push({ key: 'approve', icon: 'record_voice_over', label: t('meeting.approve'), tone: 'primary', run: () => cf.decideHand(p.userId, 'approve') });
      out.push({ key: 'reject', icon: 'do_not_touch', label: t('meeting.reject'), run: () => cf.decideHand(p.userId, 'reject') });
    }
    if (cf && (hand === 'APPROVED_TO_SPEAK' || hand === 'ACTIVE_SPEAKER')) {
      out.push({ key: 'revoke', icon: 'voice_over_off', label: t('meeting.revoke'), run: () => cf.decideHand(p.userId, 'revoke') });
    }
    if (cf) {
      const blocked = micBlocked(p.userId);
      // An invitation asks the student; their own click is what turns the microphone on.
      if (!blocked && (hand === 'IDLE' || hand === 'RELEASED'))
        out.push({ key: 'invite', icon: 'record_voice_over', label: t('meeting.invite'), tone: 'primary', run: () => cf.decideHand(p.userId, 'invite') });
      out.push(
        blocked
          ? { key: 'unblockMic', icon: 'mic', label: t('meeting.unblockMic'), run: () => cf.setControls(p.userId, { mic: 'DEFAULT' }) }
          : { key: 'blockMic', icon: 'mic_off', label: t('meeting.blockMic'), run: () => cf.setControls(p.userId, { mic: 'BLOCKED' }) },
      );
    }
    if (!cf) out.push({ key: 'mute', icon: 'mic_off', label: t('meeting.muteOne'), run: () => meeting.muteParticipant(p.sessionId) });
    if (cf) {
      const r = rtcOf.get(p.userId);
      const cam = r?.controls?.camera ?? 'DEFAULT';
      if (r?.cameraExpected && !r.video)
        out.push({ key: 'nudge', icon: 'notifications_active', label: t('meeting.camera.remind'), run: () => cf.nudgeCamera(p.userId) });
      if (cameraPolicy === 'EXPECTED' && cam !== 'BLOCKED')
        out.push(
          cam === 'EXEMPT'
            ? { key: 'unexempt', icon: 'videocam', label: t('meeting.camera.unexempt'), run: () => cf.setControls(p.userId, { camera: 'DEFAULT' }) }
            : { key: 'exempt', icon: 'videocam_off', label: t('meeting.camera.exemptAction'), run: () => cf.setControls(p.userId, { camera: 'EXEMPT' }) },
        );
      if (cameraPolicy !== 'OFF')
        out.push(
          cam === 'BLOCKED'
            ? { key: 'unblockCam', icon: 'photo_camera', label: t('meeting.camera.unblock'), run: () => cf.setControls(p.userId, { camera: 'DEFAULT' }) }
            : { key: 'blockCam', icon: 'no_photography', label: t('meeting.camera.block'), run: () => cf.setControls(p.userId, { camera: 'BLOCKED' }) },
        );
    }
    if (cf && onBonus) {
      const guest = rtcOf.get(p.userId)?.guest;
      out.push({
        key: 'bonus',
        icon: 'redeem',
        label: t('bonus.action'),
        tone: 'primary',
        ...(guest ? { disabledReason: t('bonus.guestNoPoints') } : {}),
        run: () => onBonus({ userId: p.userId, name: p.name }),
      });
    }
    out.push(...(extraActions?.({ userId: p.userId, name: p.name, hand }) ?? []));
    out.push({ key: 'remove', icon: 'person_remove', label: t('meeting.removeOne'), tone: 'danger', run: () => remove(p.userId, p.name, p.sessionId) });
    return out;
  };

  /** The camera, as the moderator needs to read it: on / off / exempt / blocked / what the device said. */
  const cameraIcon = (p: Participant) => {
    const r = rtcOf.get(p.userId ?? '');
    const ctl = r?.controls;
    if (p.video) return <StateIcon icon="videocam" label={t('meeting.camIsOn')} tone="on" />;
    if (ctl?.camera === 'BLOCKED') return <StateIcon icon="no_photography" label={t('meeting.camera.blocked')} tone="warn" />;
    if (ctl?.cameraReport)
      return <StateIcon icon="videocam_alert" label={t(`meeting.camera.report.${ctl.cameraReport}`)} tone="warn" />;
    if (ctl?.camera === 'EXEMPT') return <StateIcon icon="videocam_off" label={t('meeting.camera.exempt')} />;
    if (r?.cameraExpected) return <StateIcon icon="videocam_off" label={t('meeting.camera.expectedOff')} tone="warn" />;
    return <StateIcon icon="videocam_off" label={t('meeting.camIsOff')} tone="off" />;
  };

  const iconsFor = (p: Participant) => (
    <>
      {badges?.(p.userId ?? '')}
      {moderator && (rtcOf.get(p.userId ?? '')?.bonus ?? 0) > 0 && (
        <span
          className="rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-amber-200"
          title={t('bonus.totalHint')}
        >
          +{rtcOf.get(p.userId ?? '')?.bonus}
        </span>
      )}
      {handOf.get(p.userId ?? '') === 'HAND_RAISED' && (
        <StateIcon icon="back_hand" label={t('meeting.handUp')} tone="warn" />
      )}
      {cameraIcon(p)}
      {p.userId && micBlocked(p.userId) ? (
        <StateIcon icon="mic_off" label={t('meeting.micBlocked')} tone="warn" />
      ) : (
        <StateIcon
          icon={p.audio ? 'mic' : 'mic_off'}
          label={p.audio ? t('meeting.micIsOn') : t('meeting.micOff')}
          tone={p.audio ? 'on' : 'off'}
        />
      )}
    </>
  );
  const byUser = new Map(meeting.participants.filter((p) => p.userId).map((p) => [p.userId!, p]));

  const micPolicy = cf?.rtc?.policies?.mic ?? 'RAISE_HAND';
  const cameraPolicy = cf?.rtc?.policies?.camera ?? 'SPEAKERS_ONLY';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* The class's rules, where the teacher runs the room from. */}
      {moderator && cf && (
        <div className="mb-3 flex flex-wrap gap-2">
          <label className="inline-flex items-center gap-1.5 rounded-full bg-on-surface/[0.06] py-1 pe-1 ps-3 text-xs font-semibold">
            <span aria-hidden className="material-symbols-outlined text-[16px]">
              mic
            </span>
            <span className="text-on-surface-variant">{t('meeting.policy.mic')}</span>
            <select
              value={micPolicy}
              onChange={(e) => void cf.setMicPolicy(e.target.value as 'RAISE_HAND' | 'LISTEN_ONLY')}
              className="rounded-full bg-surface-container-highest px-2 py-1 text-xs font-semibold text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="RAISE_HAND">{t('meeting.policy.RAISE_HAND')}</option>
              <option value="LISTEN_ONLY">{t('meeting.policy.LISTEN_ONLY')}</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5 rounded-full bg-on-surface/[0.06] py-1 pe-1 ps-3 text-xs font-semibold">
            <span aria-hidden className="material-symbols-outlined text-[16px]">
              videocam
            </span>
            <span className="text-on-surface-variant">{t('meeting.policy.camera')}</span>
            <select
              value={cameraPolicy}
              onChange={(e) => void cf.setCameraPolicy(e.target.value as typeof cameraPolicy)}
              className="rounded-full bg-surface-container-highest px-2 py-1 text-xs font-semibold text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {(['SPEAKERS_ONLY', 'OPTIONAL', 'EXPECTED', 'OFF'] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`meeting.policy.cam.${v}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {moderator && cf && (cf.rtc?.admissions?.requests.filter((r) => r.status === 'PENDING').length ?? 0) > 0 && (
        <>
          <GroupTitle>
            {t('admission.panelTitle', { count: cf.rtc!.admissions!.requests.filter((r) => r.status === 'PENDING').length })}
          </GroupTitle>
          {cf.rtc!.admissions!.capacity != null && (
            <p className="mb-1 text-xs text-on-surface-variant">
              {t('admission.capacityLine', {
                capacity: cf.rtc!.admissions!.capacity,
                exceptions: cf.rtc!.admissions!.exceptions,
              })}
            </p>
          )}
          <ul>
            {cf.rtc!.admissions!.requests
              .filter((r) => r.status === 'PENDING')
              .map((r) => (
                <Row key={r.id} name={r.name} sub={t('admission.wantsToJoin')}>
                  <button
                    type="button"
                    className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    onClick={() => void cf.decideAdmission(r.id, 'APPROVE')}
                  >
                    {t('admission.admit')}
                  </button>
                  <button
                    type="button"
                    className="rounded-full px-2.5 py-1 text-xs font-semibold text-on-surface-variant hover:bg-on-surface/10"
                    onClick={() => void cf.decideAdmission(r.id, 'REJECT')}
                  >
                    {t('meeting.reject')}
                  </button>
                </Row>
              ))}
          </ul>
        </>
      )}
      {moderator && cf && raised.length > 0 && (
        <>
          <GroupTitle>{t('meeting.requests', { count: raised.length })}</GroupTitle>
          <ul>
            {raised.map((h) => (
              <Row key={h.userId} name={h.name} actions={actionsFor({ userId: h.userId, name: h.name, sessionId: h.userId })}>
                <button
                  type="button"
                  className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  onClick={() => void cf.decideHand(h.userId, 'approve')}
                >
                  {t('meeting.approve')}
                </button>
              </Row>
            ))}
          </ul>
        </>
      )}
      {cf && speaking.length > 0 && (
        <>
          <GroupTitle>{t('meeting.speakingNow')}</GroupTitle>
          <ul>
            {speaking.map((h) => {
              const p = byUser.get(h.userId);
              return (
                <Row
                  key={h.userId}
                  name={h.name}
                  sub={h.hand === 'ACTIVE_SPEAKER' ? t('meeting.speaking') : t('meeting.allowedToSpeak')}
                  icons={p ? iconsFor(p) : undefined}
                  actions={actionsFor({ userId: h.userId, name: h.name, sessionId: h.userId })}
                />
              );
            })}
          </ul>
        </>
      )}
      <GroupTitle>{t('meeting.inClass', { count: rest.length })}</GroupTitle>
      {rest.length === 0 ? (
        <p className="py-3 text-sm text-outline">{t('meeting.noStudentsYet')}</p>
      ) : (
        <ul>
          {rest.map((p) => (
            <Row
              key={p.sessionId}
              name={p.local ? `${p.name || t('meeting.you')} (${t('meeting.you')})` : p.name}
              sub={p.owner ? t('meeting.teacherBadge') : undefined}
              icons={iconsFor(p)}
              actions={!p.local && !p.owner ? actionsFor({ userId: p.userId ?? p.sessionId, name: p.name, sessionId: p.sessionId }) : undefined}
            />
          ))}
        </ul>
      )}
      {notJoined.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-bold text-on-surface-variant">
            {t('meeting.notJoined', { count: notJoined.length })}
          </summary>
          <ul className="mt-1">
            {notJoined.map((n) => (
              <Row key={n.userId} name={n.name} sub={n.guest ? t('liveManage.guest') : undefined} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

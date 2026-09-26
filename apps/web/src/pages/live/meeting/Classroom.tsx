import { AnimatePresence, m, MotionConfig } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { askConfirm } from '../../../lib/confirm';
import type { Participant } from '../../../lib/useDailyMeeting';
import type { LiveMeeting } from '../../../lib/useLiveMeeting';
import { useLiveChat } from '../../../lib/useLiveChat';
import { formatClock, useClockTick, type ClockAnchor } from '../../../lib/useSessionClock';
import { NameTag, Tile, Video, Initial } from './media';
import { getSocket } from '../../../lib/socket';
import { playLiveSound, setSoundsMuted, soundsMuted } from '../../../lib/liveSounds';

type Cf = Extract<LiveMeeting, { provider: 'cloudflare' }>;
type Panel = 'people' | 'chat' | null;
type Layout = 'auto' | 'focus' | 'gallery';

/* ── Small parts ─────────────────────────────────────────────────────────── */

/**
 * A dock control: an icon, a label for assistive tech, and a tooltip for
 * everyone else. States are shape and colour both — never colour alone.
 */
function Ctl({
  icon,
  label,
  onClick,
  active,
  off,
  disabled,
  badge,
  tone,
  showLabel,
  labelLg,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  off?: boolean;
  disabled?: boolean;
  badge?: number | 'dot';
  tone?: 'danger';
  showLabel?: boolean;
  /** Icon-only on small screens, icon and word from `lg` up. */
  labelLg?: boolean;
}) {
  const color =
    tone === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-500'
      : off
        ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
        : active
          ? 'bg-primary text-on-primary hover:bg-primary/90'
          : 'bg-white/[0.08] text-zinc-100 hover:bg-white/[0.14]';
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active ?? (off !== undefined ? !off : undefined)}
        className={`relative inline-flex h-11 items-center justify-center gap-2 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-40 ${
          showLabel ? 'px-4' : labelLg ? 'w-11 lg:w-auto lg:px-4' : 'w-11'
        } ${color}`}
      >
        <span aria-hidden className="material-symbols-outlined text-[22px]">
          {icon}
        </span>
        {showLabel && <span className="text-sm font-semibold">{label}</span>}
        {labelLg && <span className="hidden text-sm font-semibold lg:inline">{label}</span>}
        {badge !== undefined && badge !== 0 && (
          <span
            aria-hidden
            className={`absolute -top-0.5 -end-0.5 grid min-w-[1.1rem] place-items-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-zinc-950 ${
              badge === 'dot' ? 'h-2.5 w-2.5 min-w-0 p-0' : 'h-[1.1rem]'
            }`}
          >
            {badge === 'dot' ? '' : badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>
      {!showLabel && (
        <span
          aria-hidden
          className={`pointer-events-none absolute bottom-full start-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-100 shadow-lg group-hover:block group-focus-within:block rtl:translate-x-1/2 ${labelLg ? 'lg:!hidden' : ''}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}

/** Elapsed and remaining, ticking here only — the video tree never re-renders for it. */
const SessionClock = memo(function SessionClock({ anchor }: { anchor: ClockAnchor | null }) {
  const { t } = useTranslation();
  const c = useClockTick(anchor);
  if (!c) return null;
  const late = c.remainingMs <= 5 * 60_000;
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1 text-xs font-semibold tabular-nums" dir="ltr">
      {c.elapsedMs != null && (
        <span className="hidden text-zinc-300 sm:inline" title={t('meeting.elapsed')}>
          {formatClock(c.elapsedMs)}
        </span>
      )}
      <span className={late ? 'text-amber-300' : 'text-zinc-400'} title={t('meeting.remaining')}>
        {c.remainingMs > 0 ? `${formatClock(c.remainingMs)} ${t('meeting.left')}` : t('meeting.overtime')}
      </span>
    </span>
  );
});

/* ── Stage ───────────────────────────────────────────────────────────────── */

function StageFrame({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <div className={`relative min-h-0 overflow-hidden rounded-xl bg-zinc-900 ${className}`}>{children}</div>
  );
}

function MainTile({ p, isTeacher, pinned }: { p: Participant; isTeacher: boolean; pinned: boolean }) {
  return (
    <StageFrame className="h-full w-full">
      {p.video && p.track ? (
        <Video track={p.track} muted={p.local} mirror={p.local} />
      ) : (
        <Initial name={p.name} />
      )}
      <span className="absolute bottom-3 start-3 max-w-[80%]">
        <NameTag p={p} isTeacher={isTeacher} pinned={pinned} />
      </span>
    </StageFrame>
  );
}

/* ── The classroom ───────────────────────────────────────────────────────── */

export interface ClassroomProps {
  sessionId: string;
  title: string;
  userId: string | null;
  amOwner: boolean;
  meeting: LiveMeeting;
  anchor: ClockAnchor | null;
  extend: { run: () => void; pending: boolean; note: string | null };
  recording: { active: boolean; pending: boolean; toggle: () => void };
  onLeave: () => void;
  onEndClass: () => void;
  ending: boolean;
}

export default function Classroom(props: ClassroomProps) {
  const { t } = useTranslation();
  const { sessionId, title, amOwner, meeting, anchor, extend, recording } = props;
  const cf: Cf | null = meeting.provider === 'cloudflare' ? (meeting as Cf) : null;
  const [panel, setPanel] = useState<Panel>(null);
  const [layout, setLayout] = useState<Layout>('auto');
  const [pinned, setPinned] = useState<string | null>(null);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const chat = useLiveChat(sessionId, panel === 'chat');
  const [reactMenu, setReactMenu] = useState(false);
  const [muted, setMuted] = useState(soundsMuted);
  const [floating, setFloating] = useState<{ id: number; emoji: string; name: string; x: number }[]>([]);
  const namesRef = useRef(new Map<string, string>());
  namesRef.current = new Map(meeting.participants.map((p) => [p.userId ?? p.sessionId, p.local ? t('meeting.you') : p.name]));

  // Reactions: sent to the room; everyone (the sender too) sees them float up.
  const sendReaction = useCallback(
    (emoji: string) => getSocket()?.emit('live:react', { sessionId, emoji }),
    [sessionId],
  );
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let n = 0;
    const onReaction = (p: { sessionId: string; userId: string; emoji: string }) => {
      if (p?.sessionId !== sessionId) return;
      const id = ++n + Date.now();
      const item = { id, emoji: p.emoji, name: namesRef.current.get(p.userId) ?? '', x: Math.random() * 60 };
      // Never more than a dozen on screen: a burst stays readable.
      setFloating((cur) => [...cur.slice(-11), item]);
      setTimeout(() => setFloating((cur) => cur.filter((f) => f.id !== id)), 2800);
    };
    sock.on('live:reaction', onReaction);
    return () => {
      sock.off('live:reaction', onReaction);
    };
  }, [sessionId]);

  // Sounds: someone arrived or left, a hand went up (the teacher), a message
  // from someone else. Compared with the previous render, never on the first.
  const prev = useRef<{ people: number; hands: number; msgs: number } | null>(null);
  const peopleNow = meeting.participants.length;
  const handsNow = (meeting.provider === 'cloudflare' ? (meeting as Cf).hands : []).filter(
    (h) => h.hand === 'HAND_RAISED',
  ).length;
  const msgsNow = chat.messages.length;
  useEffect(() => {
    const was = prev.current;
    prev.current = { people: peopleNow, hands: handsNow, msgs: msgsNow };
    if (!was) return;
    if (amOwner && handsNow > was.hands) playLiveSound('hand');
    else if (peopleNow > was.people) playLiveSound('join');
    else if (peopleNow < was.people) playLiveSound('leave');
    if (msgsNow > was.msgs) {
      const last = chat.messages[chat.messages.length - 1];
      if (last && last.senderId !== props.userId) playLiveSound('message');
    }
  }, [peopleNow, handsNow, msgsNow]); // eslint-disable-line react-hooks/exhaustive-deps

  const participants = meeting.participants;
  const me = participants.find((p) => p.local) ?? null;
  const others = participants.filter((p) => !p.local);
  const teacher = participants.find((p) => p.owner && !p.local) ?? null;
  const remoteScreen = others.find((p) => p.screen && p.screenTrack) ?? null;
  const sharingMine = meeting.sharing;
  const students = participants.filter((p) => !p.owner);
  const hands = cf?.hands ?? [];
  const raised = hands.filter((h) => h.hand === 'HAND_RAISED');
  const speaking = hands.filter((h) => h.hand === 'APPROVED_TO_SPEAK' || h.hand === 'ACTIVE_SPEAKER');
  const myHand = cf?.rtc?.me.hand ?? 'IDLE';
  const canSend = !cf || amOwner || !!cf.rtc?.me.canPublish;
  const isTeacherP = useCallback((p: Participant) => p.owner, []);

  // Pinning is local and forgiving: pinning someone who left just unpins.
  useEffect(() => {
    if (pinned && !participants.some((p) => p.sessionId === pinned)) setPinned(null);
  }, [participants, pinned]);
  const onPin = useCallback((pid: string) => setPinned((cur) => (cur === pid ? null : pid)), []);

  const presenting = !!remoteScreen || sharingMine;
  const effective: 'presentation' | 'focus' | 'gallery' =
    layout === 'gallery' ? 'gallery' : layout === 'focus' ? 'focus' : presenting ? 'presentation' : 'focus';

  // Who is on screen besides the content: people with a camera or a voice.
  const withMedia = useMemo(
    () => participants.filter((p) => p.video || (p.audio && !p.local) || p.owner || p.local),
    [participants],
  );
  const pinnedP = pinned ? participants.find((p) => p.sessionId === pinned) ?? null : null;
  const activeStudent = students.find((p) => !p.local && (p.video || p.audio)) ?? null;
  const focusMain: Participant | null =
    pinnedP ?? (amOwner ? activeStudent?.video ? activeStudent : me : teacher ?? activeStudent ?? me);
  const strip = withMedia.filter((p) => p.sessionId !== focusMain?.sessionId);
  const listeners = students.filter((p) => !p.local && !p.video && !p.audio);

  // Announcements for screen readers — and a quiet line for everyone else.
  const announce =
    cf?.connection === 'reconnecting'
      ? t('meeting.reconnecting')
      : extend.note ?? (meeting.notice ? t(`meeting.notice.${meeting.notice}`) : null);

  const endClass = async () => {
    const ok = await askConfirm(t('meeting.endConfirmBody'), {
      title: t('meeting.endConfirmTitle'),
      confirmLabel: t('meeting.endForAll'),
      cancelLabel: t('meeting.keepTeaching'),
      danger: true,
    });
    if (ok) props.onEndClass();
  };

  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  /* ── Stage content ── */
  const stage = (() => {
    if (effective === 'presentation') {
      const cam = amOwner ? me : teacher;
      const side = [cam, ...students.filter((p) => !p.local && (p.video || p.audio))].filter(
        (p): p is Participant => !!p,
      );
      return (
        <div className="relative h-full w-full">
          <StageFrame className="h-full w-full bg-black">
            {sharingMine && !remoteScreen ? (
              // Not the screen itself: a mirror of your own screen inside your
              // screen is a hall of mirrors. What you need is to know, and to stop.
              <div className="grid h-full place-items-center p-6 text-center">
                <div>
                  <span aria-hidden className="material-symbols-outlined text-5xl text-primary">
                    present_to_all
                  </span>
                  <p className="mt-3 font-heading text-lg font-bold">{t('meeting.youAreSharing')}</p>
                  <p className="mt-1 text-sm text-zinc-400">{t('meeting.youAreSharingHint')}</p>
                  <button
                    type="button"
                    className="mt-4 inline-flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    onClick={meeting.toggleShare}
                  >
                    <span aria-hidden className="material-symbols-outlined text-[18px]">cancel_presentation</span>
                    {t('meeting.stopSharing')}
                  </button>
                </div>
              </div>
            ) : remoteScreen ? (
              <Video track={remoteScreen.screenTrack} muted />
            ) : null}
            {remoteScreen && (
              <span className="absolute top-3 start-3 rounded-lg bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
                {t('meeting.sharingScreen', { name: remoteScreen.name })}
              </span>
            )}
          </StageFrame>
          {/* The teacher, and whoever is speaking, beside the content — small
              and out of the way of what is being shown. */}
          {side.length > 0 && (
            <div className="absolute bottom-3 end-3 flex w-32 flex-col gap-2 sm:w-44 lg:w-52">
              {side.slice(0, 3).map((p) => (
                <Tile key={p.sessionId} p={p} isTeacher={isTeacherP(p)} pinned={false} compact />
              ))}
            </div>
          )}
        </div>
      );
    }
    if (effective === 'gallery') {
      const all = [...withMedia, ...participants.filter((p) => !withMedia.includes(p))].slice(0, 16);
      const n = all.length;
      const cols = n <= 1 ? 'grid-cols-1' : n <= 4 ? 'grid-cols-2' : n <= 9 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-3 md:grid-cols-4';
      return (
        <div className={`grid h-full w-full content-center gap-2 overflow-y-auto ${cols}`}>
          {all.map((p) => (
            <Tile key={p.sessionId} p={p} isTeacher={isTeacherP(p)} pinned={pinned === p.sessionId} onPin={onPin} />
          ))}
        </div>
      );
    }
    return (
      <div className="flex h-full w-full flex-col gap-2">
        <div className="min-h-0 flex-1">
          {focusMain ? (
            <MainTile p={focusMain} isTeacher={isTeacherP(focusMain)} pinned={pinned === focusMain.sessionId} />
          ) : (
            <StageFrame className="h-full w-full" />
          )}
        </div>
        {strip.length > 0 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-0.5">
            {strip.map((p) => (
              <div key={p.sessionId} className="w-28 shrink-0 sm:w-36">
                <Tile p={p} isTeacher={isTeacherP(p)} pinned={pinned === p.sessionId} onPin={onPin} compact />
              </div>
            ))}
          </div>
        )}
        {/* The audience. Listening students send nothing, so they have no
            tile — but a teacher talking to an empty-looking room is talking
            to nobody. A quiet row of who is there. */}
        {amOwner && listeners.length > 0 && (
          <button
            type="button"
            onClick={() => toggle('people')}
            className="flex shrink-0 items-center gap-3 self-start rounded-full bg-white/[0.05] py-1.5 ps-1.5 pe-4 text-sm text-zinc-300 hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex -space-x-2 rtl:space-x-reverse">
              {listeners.slice(0, 6).map((p) => (
                <span
                  key={p.sessionId}
                  aria-hidden
                  className="grid h-7 w-7 place-items-center rounded-full bg-zinc-700 text-xs font-bold text-zinc-100 ring-2 ring-zinc-950"
                >
                  {p.name.trim().charAt(0) || '؟'}
                </span>
              ))}
            </span>
            {t('meeting.listening', { count: listeners.length })}
          </button>
        )}
      </div>
    );
  })();

  const alone = amOwner && students.length === 0;
  const waitingTeacher = !amOwner && !teacher;

  return (
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 flex flex-col bg-zinc-950 text-zinc-100">
        {/* ── Top bar ── */}
        <header className="flex h-14 shrink-0 items-center gap-3 px-3 sm:px-4">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-[11px] font-bold text-white">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" />
            {t('meeting.live')}
          </span>
          <h1 className="min-w-0 flex-1 truncate font-heading text-sm font-semibold sm:text-base" dir="auto">
            {title}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <SessionClock anchor={anchor} />
            {amOwner && (
              <button
                type="button"
                onClick={extend.run}
                disabled={extend.pending}
                className="hidden items-center gap-1 rounded-full bg-white/[0.06] px-3 py-1 text-xs font-semibold text-zinc-200 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 sm:inline-flex"
              >
                <span aria-hidden className="material-symbols-outlined text-[16px]">more_time</span>
                {extend.pending ? t('meeting.extending') : t('meeting.extend')}
              </button>
            )}
            {recording.active && (
              // Everyone is told, not only the teacher: being recorded is
              // something a class is entitled to know at a glance.
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/15 px-2.5 py-1 text-[11px] font-bold text-red-300" role="status">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-400 motion-safe:animate-pulse" />
                {t('meeting.recordingBadge')}
              </span>
            )}
            {meeting.provider === 'cloudflare' && meeting.transcribing && (
              <span
                className="hidden items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-zinc-300 sm:inline-flex"
                role="status"
                title={t('meeting.transcriptOnHint')}
              >
                <span aria-hidden className="material-symbols-outlined text-[14px]">subtitles</span>
                {t('meeting.transcriptOn')}
              </span>
            )}
            <button
              type="button"
              onClick={() => toggle('people')}
              className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('meeting.peopleCount', { count: participants.length })}
            >
              <span aria-hidden className="material-symbols-outlined text-[16px]">group</span>
              <span className="tabular-nums">{participants.length}</span>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* ── Stage ── */}
          <main className="relative min-w-0 flex-1 px-2 pb-2 sm:px-3">
            {stage}

            {/* Status, never a curtain over the video. */}
            {(alone || waitingTeacher) && effective !== 'presentation' && (
              <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
                <div className="flex items-center gap-2 rounded-full bg-zinc-900/90 px-4 py-2 text-sm shadow-lg ring-1 ring-white/10">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="font-semibold">{alone ? t('meeting.readyTitle') : t('meeting.waitingTeacherTitle')}</span>
                  <span className="text-zinc-400">· {alone ? t('meeting.waitingStudents') : t('meeting.waitingTeacherInRoom')}</span>
                </div>
              </div>
            )}

            {/* A raised hand reaches the teacher without opening anything. */}
            {amOwner && raised.length > 0 && panel !== 'people' && (
              <m.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="absolute top-3 end-4 flex items-center gap-3 rounded-xl bg-zinc-900/95 py-2 ps-3 pe-2 shadow-lg ring-1 ring-amber-400/40"
                role="status"
              >
                <span aria-hidden className="material-symbols-outlined text-[20px] text-amber-300">back_hand</span>
                <span className="text-sm">
                  <b>{raised[0].name}</b>
                  {raised.length > 1 ? ` ${t('meeting.andOthers', { count: raised.length - 1 })}` : ''}
                </span>
                <button
                  type="button"
                  className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-on-primary"
                  onClick={() => void cf?.decideHand(raised[0].userId, 'approve')}
                >
                  {t('meeting.approve')}
                </button>
                <button
                  type="button"
                  className="rounded-full px-2 py-1 text-xs font-semibold text-zinc-300 hover:bg-white/10"
                  onClick={() => setPanel('people')}
                >
                  {t('meeting.viewAll')}
                </button>
              </m.div>
            )}

            {/* Phones may refuse sound until tapped. */}
            {cf?.audioBlocked && (
              <button
                type="button"
                onClick={cf.resumeAudio}
                className="absolute inset-x-0 top-16 mx-auto flex w-fit items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-lg"
              >
                <span aria-hidden className="material-symbols-outlined text-[18px]">volume_up</span>
                {t('meeting.enableSound')}
              </button>
            )}

            {/* Reactions rise from the bottom corner and fade. Decorative for
                screen readers: the room would be read a stream of emoji. */}
            <div aria-hidden className="pointer-events-none absolute bottom-6 end-6 h-2/3 w-40 overflow-hidden">
              {floating.map((f) => (
                <m.div
                  key={f.id}
                  initial={{ opacity: 0, y: 0, scale: 0.6 }}
                  animate={{ opacity: [0, 1, 1, 0], y: -260, scale: 1 }}
                  transition={{ duration: 2.6, ease: 'easeOut' }}
                  className="absolute bottom-0 flex flex-col items-center"
                  style={{ insetInlineEnd: `${f.x}%` }}
                >
                  <span className="text-3xl">{f.emoji}</span>
                  {f.name && (
                    <span className="mt-0.5 max-w-[7rem] truncate rounded-full bg-black/60 px-2 text-[10px] font-semibold text-white">
                      {f.name}
                    </span>
                  )}
                </m.div>
              ))}
            </div>

            <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
              <AnimatePresence>
                {announce && (
                  <m.p
                    key={announce}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className={`rounded-full px-4 py-2 text-sm font-semibold shadow-lg ${
                      cf?.connection === 'reconnecting' ? 'bg-amber-400 text-zinc-950' : 'bg-zinc-800 text-zinc-100'
                    }`}
                  >
                    {announce}
                  </m.p>
                )}
              </AnimatePresence>
            </div>
          </main>

          {/* ── Side panel ── */}
          <SidePanel
            panel={panel}
            setPanel={setPanel}
            amOwner={amOwner}
            meeting={meeting}
            cf={cf}
            raised={raised}
            speaking={speaking}
            chat={chat}
            userId={props.userId}
          />
        </div>

        {/* ── Dock ── */}
        <footer className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4">
          <div className="hidden min-w-0 items-center gap-2 text-xs text-zinc-400 md:flex">
            {cf && !amOwner && myHand === 'HAND_RAISED' && (
              <span className="inline-flex items-center gap-1.5 text-amber-300">
                <span aria-hidden className="material-symbols-outlined text-[16px]">back_hand</span>
                {t('meeting.handRaisedYou')}
              </span>
            )}
            {cf && !amOwner && myHand === 'APPROVED_TO_SPEAK' && !meeting.micOn && (
              <span className="text-emerald-300">{t('meeting.youCanSpeak')}</span>
            )}
          </div>

          <div className="col-span-3 flex flex-wrap items-center justify-center gap-2 md:col-span-1 md:gap-3">
            <div className="flex items-center gap-2">
              {canSend && (
                <>
                  <Ctl
                    icon={meeting.micOn ? 'mic' : 'mic_off'}
                    off={!meeting.micOn}
                    label={meeting.micOn ? t('meeting.muteMic') : t('meeting.unmuteMic')}
                    onClick={meeting.toggleMic}
                  />
                  <Ctl
                    icon={meeting.camOn ? 'videocam' : 'videocam_off'}
                    off={!meeting.camOn}
                    label={meeting.camOn ? t('meeting.camOff') : t('meeting.camOn')}
                    onClick={meeting.toggleCam}
                  />
                </>
              )}
              {cf && !amOwner && (
                <Ctl
                  icon="back_hand"
                  showLabel
                  active={myHand !== 'IDLE' && myHand !== 'RELEASED'}
                  label={
                    myHand === 'IDLE' || myHand === 'RELEASED'
                      ? t('meeting.raiseHand')
                      : myHand === 'HAND_RAISED'
                        ? t('meeting.lowerHand')
                        : t('meeting.stopSpeaking')
                  }
                  onClick={() => void (myHand === 'IDLE' || myHand === 'RELEASED' ? cf.raiseHand() : cf.lowerHand())}
                />
              )}
            </div>

            {(amOwner || !cf) && (
              <div className="flex items-center gap-2 md:border-s md:border-white/10 md:ps-3">
                <Ctl
                  icon={sharingMine ? 'cancel_presentation' : 'present_to_all'}
                  active={sharingMine}
                  disabled={!meeting.canShare}
                  label={
                    !meeting.canShare
                      ? t('meeting.shareUnsupported')
                      : sharingMine
                        ? t('meeting.stopSharing')
                        : t('meeting.share')
                  }
                  onClick={meeting.toggleShare}
                />
                {amOwner && (
                  <Ctl
                    icon="radio_button_checked"
                    active={recording.active}
                    disabled={recording.pending}
                    label={recording.active ? t('meeting.stopRec') : t('meeting.startRec')}
                    onClick={recording.toggle}
                  />
                )}
              </div>
            )}

            <div className="flex items-center gap-2 md:border-s md:border-white/10 md:ps-3">
              <Ctl
                icon="group"
                active={panel === 'people'}
                badge={amOwner ? raised.length : undefined}
                label={t('meeting.people')}
                labelLg
                onClick={() => toggle('people')}
              />
              <Ctl
                icon="chat"
                active={panel === 'chat'}
                badge={panel !== 'chat' ? chat.unread : undefined}
                label={t('meeting.chat')}
                labelLg
                onClick={() => toggle('chat')}
              />
              <span className="relative">
                <Ctl
                  icon="add_reaction"
                  active={reactMenu}
                  label={t('meeting.react.title')}
                  onClick={() => setReactMenu((v) => !v)}
                />
                {reactMenu && (
                  <ReactionPicker
                    onPick={(e) => {
                      sendReaction(e);
                      setReactMenu(false);
                    }}
                    onClose={() => setReactMenu(false)}
                  />
                )}
              </span>
              <Ctl
                icon={muted ? 'volume_off' : 'notifications_active'}
                off={muted}
                label={muted ? t('meeting.sounds.on') : t('meeting.sounds.off')}
                onClick={() => {
                  setSoundsMuted(!muted);
                  setMuted(!muted);
                }}
              />
              <span className="relative">
                <Ctl
                  icon="grid_view"
                  active={layoutMenu}
                  label={t('meeting.layout.title')}
                  onClick={() => setLayoutMenu((v) => !v)}
                />
                {layoutMenu && (
                  <LayoutMenu
                    value={layout}
                    onChange={(l) => {
                      setLayout(l);
                      setLayoutMenu(false);
                    }}
                    onClose={() => setLayoutMenu(false)}
                  />
                )}
              </span>
            </div>

            {/* Leaving and ending are different acts and look different. */}
            <div className="flex items-center gap-2 md:hidden">
              <Ctl icon="call_end" tone="danger" label={t('meeting.leave')} onClick={props.onLeave} />
            </div>
          </div>

          <div className="hidden items-center justify-end gap-2 md:flex">
            <Ctl icon="logout" label={t('meeting.leave')} onClick={props.onLeave} showLabel />
            {amOwner && (
              <button
                type="button"
                onClick={endClass}
                disabled={props.ending}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:opacity-50"
              >
                <span aria-hidden className="material-symbols-outlined text-[20px]">stop_circle</span>
                {t('meeting.endForAll')}
              </button>
            )}
          </div>
          {amOwner && (
            <div className="col-span-3 flex justify-center md:hidden">
              <button
                type="button"
                onClick={endClass}
                disabled={props.ending}
                className="text-xs font-semibold text-red-300 underline-offset-2 hover:underline"
              >
                {t('meeting.endForAll')}
              </button>
            </div>
          )}
        </footer>
      </div>
    </MotionConfig>
  );
}

/* ── Reactions ───────────────────────────────────────────────────────────── */

const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '🤔'];

function ReactionPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('meeting.react.title')}
      className="absolute bottom-full start-1/2 z-20 mb-2 flex -translate-x-1/2 gap-1 rounded-full bg-zinc-800 p-1.5 shadow-xl ring-1 ring-white/10 rtl:translate-x-1/2"
    >
      {REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitem"
          aria-label={t(`meeting.react.${REACTIONS.indexOf(e)}`)}
          onClick={() => onPick(e)}
          className="grid h-10 w-10 place-items-center rounded-full text-2xl transition-transform duration-150 hover:scale-110 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:hover:scale-100"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/* ── Layout menu ─────────────────────────────────────────────────────────── */

function LayoutMenu({
  value,
  onChange,
  onClose,
}: {
  value: Layout;
  onChange: (l: Layout) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const items: { v: Layout; icon: string }[] = [
    { v: 'auto', icon: 'auto_awesome_mosaic' },
    { v: 'focus', icon: 'crop_landscape' },
    { v: 'gallery', icon: 'grid_view' },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('meeting.layout.title')}
      className="absolute bottom-full end-0 z-20 mb-2 w-60 rounded-xl bg-zinc-800 p-1.5 shadow-xl ring-1 ring-white/10"
    >
      {items.map((it) => (
        <button
          key={it.v}
          type="button"
          role="menuitemradio"
          aria-checked={value === it.v}
          onClick={() => onChange(it.v)}
          className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            value === it.v ? 'bg-white/10' : 'hover:bg-white/5'
          }`}
        >
          <span aria-hidden className="material-symbols-outlined mt-0.5 text-[20px]">{it.icon}</span>
          <span>
            <span className="block text-sm font-semibold">{t(`meeting.layout.${it.v}`)}</span>
            <span className="block text-xs text-zinc-400">{t(`meeting.layout.${it.v}Hint`)}</span>
          </span>
          {value === it.v && <span aria-hidden className="material-symbols-outlined ms-auto text-[18px] text-primary">check</span>}
        </button>
      ))}
    </div>
  );
}

/* ── Side panel: people and chat ─────────────────────────────────────────── */

function SidePanel({
  panel,
  setPanel,
  amOwner,
  meeting,
  cf,
  raised,
  speaking,
  chat,
  userId,
}: {
  panel: Panel;
  setPanel: (p: Panel) => void;
  amOwner: boolean;
  meeting: LiveMeeting;
  cf: Cf | null;
  raised: Cf['hands'];
  speaking: Cf['hands'];
  chat: ReturnType<typeof useLiveChat>;
  userId: string | null;
}) {
  const { t } = useTranslation();
  const open = panel !== null;
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    closeRef.current?.focus();
    return () => (opener.current as HTMLElement | null)?.focus?.();
  }, [open]);

  if (!open) return null;
  return (
    <>
      {/* Below the widest screens the panel floats over the stage. */}
      <div aria-hidden className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={() => setPanel(null)} />
      <aside
        aria-label={panel === 'chat' ? t('meeting.chat') : t('meeting.people')}
        onKeyDown={(e) => e.key === 'Escape' && setPanel(null)}
        className="fixed inset-y-0 end-0 z-40 flex w-full flex-col bg-zinc-900 sm:w-[380px] xl:static xl:z-auto xl:me-3 xl:mb-2 xl:w-[340px] xl:rounded-xl"
      >
        <div className="flex h-14 shrink-0 items-center gap-1 px-3">
          <div role="tablist" className="flex flex-1 gap-1">
            {(['people', 'chat'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={panel === tab}
                onClick={() => setPanel(tab)}
                className={`rounded-full px-3 py-1.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  panel === tab ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {tab === 'people' ? t('meeting.people') : t('meeting.chat')}
                {tab === 'people' && amOwner && raised.length > 0 && (
                  <span className="ms-1.5 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-zinc-950">
                    {raised.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close')}
            onClick={() => setPanel(null)}
            className="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        {panel === 'people' ? (
          <People amOwner={amOwner} meeting={meeting} cf={cf} raised={raised} speaking={speaking} />
        ) : (
          <Chat chat={chat} userId={userId} />
        )}
      </aside>
    </>
  );
}

function Person({ name, sub, children }: { name: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-700 text-sm font-bold">
        {name.trim().charAt(0) || '؟'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" dir="auto">
          {name}
        </span>
        {sub && <span className="block text-xs text-zinc-400">{sub}</span>}
      </span>
      {children}
    </li>
  );
}

function GroupTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 mt-4 text-xs font-bold text-zinc-400 first:mt-0">{children}</h3>;
}

function People({
  amOwner,
  meeting,
  cf,
  raised,
  speaking,
}: {
  amOwner: boolean;
  meeting: LiveMeeting;
  cf: Cf | null;
  raised: Cf['hands'];
  speaking: Cf['hands'];
}) {
  const { t } = useTranslation();
  const handIds = new Set([...raised, ...speaking].map((h) => h.userId));
  const rest = meeting.participants.filter((p) => !p.userId || !handIds.has(p.userId));
  const remove = async (p: Participant) => {
    if (await askConfirm(t('meeting.removeConfirm', { name: p.name }), { danger: true, confirmLabel: t('meeting.removeOne') }))
      meeting.removeParticipant(p.sessionId);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {amOwner && cf && raised.length > 0 && (
        <>
          <GroupTitle>{t('meeting.requests', { count: raised.length })}</GroupTitle>
          <ul>
            {raised.map((h) => (
              <Person key={h.userId} name={h.name}>
                <button
                  type="button"
                  className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  onClick={() => void cf.decideHand(h.userId, 'approve')}
                >
                  {t('meeting.approve')}
                </button>
                <button
                  type="button"
                  className="rounded-full px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => void cf.decideHand(h.userId, 'reject')}
                >
                  {t('meeting.reject')}
                </button>
              </Person>
            ))}
          </ul>
        </>
      )}
      {cf && speaking.length > 0 && (
        <>
          <GroupTitle>{t('meeting.speakingNow')}</GroupTitle>
          <ul>
            {speaking.map((h) => (
              <Person
                key={h.userId}
                name={h.name}
                sub={h.hand === 'ACTIVE_SPEAKER' ? t('meeting.speaking') : t('meeting.allowedToSpeak')}
              >
                {amOwner && (
                  <button
                    type="button"
                    className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => void cf.decideHand(h.userId, 'revoke')}
                  >
                    {t('meeting.revoke')}
                  </button>
                )}
              </Person>
            ))}
          </ul>
        </>
      )}
      <GroupTitle>{t('meeting.inClass', { count: rest.length })}</GroupTitle>
      {rest.length === 0 ? (
        <p className="py-3 text-sm text-zinc-500">{t('meeting.noStudentsYet')}</p>
      ) : (
        <ul>
          {rest.map((p) => (
            <Person
              key={p.sessionId}
              name={p.local ? `${p.name || t('meeting.you')} (${t('meeting.you')})` : p.name}
              sub={p.owner ? t('meeting.teacherBadge') : undefined}
            >
              {!p.audio && (
                <span aria-label={t('meeting.micOff')} className="material-symbols-outlined text-[18px] text-zinc-500">
                  mic_off
                </span>
              )}
              {amOwner && !p.local && !p.owner && (
                <>
                  {!cf && (
                    <button
                      type="button"
                      aria-label={t('meeting.muteOne')}
                      title={t('meeting.muteOne')}
                      className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => meeting.muteParticipant(p.sessionId)}
                    >
                      <span className="material-symbols-outlined text-[18px]">mic_off</span>
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={t('meeting.removeOne')}
                    title={t('meeting.removeOne')}
                    className="grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => void remove(p)}
                  >
                    <span className="material-symbols-outlined text-[18px]">person_remove</span>
                  </button>
                </>
              )}
            </Person>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chat({ chat, userId }: { chat: ReturnType<typeof useLiveChat>; userId: string | null }) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [chat.messages.length]);
  return (
    <>
      <div ref={feed} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2" aria-live="polite">
        {chat.messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">{t('meeting.chatEmpty')}</p>
        ) : (
          chat.messages.map((msg) => {
            const mine = msg.senderId === userId;
            return (
              <div key={msg.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                {!mine && (
                  <span className="mb-0.5 text-[11px] font-semibold text-zinc-400">
                    {msg.senderName}
                    {msg.senderRole === 'TEACHER' && ` · ${t('meeting.teacherBadge')}`}
                  </span>
                )}
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${mine ? 'bg-primary text-on-primary' : 'bg-white/[0.08]'}`}>
                  <p className="whitespace-pre-wrap break-words text-sm" dir="auto">
                    {msg.body}
                  </p>
                </div>
                <span className="mt-0.5 text-[10px] text-zinc-500">
                  {new Date(msg.createdAt).toLocaleTimeString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            );
          })
        )}
      </div>
      <form
        className="flex shrink-0 items-center gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft;
          setDraft('');
          void chat.send(text);
        }}
      >
        <input
          className="h-11 min-w-0 flex-1 rounded-full bg-white/[0.08] px-4 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-primary"
          dir="auto"
          value={draft}
          maxLength={2000}
          placeholder={t('meeting.chatPh')}
          aria-label={t('meeting.chatPh')}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          aria-label={t('meeting.send')}
          disabled={!draft.trim() || chat.sending}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <span className="material-symbols-outlined text-[20px] rtl:-scale-x-100">send</span>
        </button>
      </form>
    </>
  );
}

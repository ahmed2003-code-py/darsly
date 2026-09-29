import { m } from 'framer-motion';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLobbyDevices, type DeviceProblem } from '../../../lib/liveDevices';
import { countdown } from '../../../lib/livePolling';
import ColorModeToggle from '../../../components/ColorModeToggle';
import { useNow } from '../../../components/live/LivePublicShell';
import { Video } from './media';

export interface LobbySession {
  title: string;
  startsAt: string;
  durationMin: number;
}

/** Why the door is not open yet — from the server's refusal, which carries the session. */
export interface LobbyWaiting {
  code: 'NOT_OPEN_YET' | 'NOT_STARTED';
  /** When entry opens (15 minutes before the start). */
  opensAt: number;
}

function when(iso: string, lang: string) {
  return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A round control on the preview. Drawn over video, so its colours are the video's. */
function PreviewToggle({
  on,
  iconOn,
  iconOff,
  label,
  onClick,
  disabled,
}: {
  on: boolean;
  iconOn: string;
  iconOff: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={`grid h-12 w-12 place-items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 ${
        on ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-red-600 text-white hover:bg-red-500'
      }`}
    >
      <span className="material-symbols-outlined text-[22px]">{on ? iconOn : iconOff}</span>
    </button>
  );
}

function Meter({ level }: { level: number | null }) {
  // Five bars; lit by level. A meter says "we can hear you" better than a word.
  const lit = level == null ? 0 : Math.round(level * 5 + 0.2);
  return (
    <span className="flex h-4 items-end gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-sm transition-colors duration-100 ${i < lit ? 'bg-emerald-500' : 'bg-outline-variant'}`}
          style={{ height: `${6 + i * 2.5}px` }}
        />
      ))}
    </span>
  );
}

function DeviceLine({
  icon,
  title,
  status,
  problem,
  onRetry,
  children,
}: {
  icon: string;
  title: string;
  status: React.ReactNode;
  problem: string | null;
  onRetry?: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3 py-3">
      <span
        aria-hidden
        className={`material-symbols-outlined mt-0.5 text-[22px] ${problem ? 'text-error' : 'text-on-surface-variant'}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs text-outline">{status}</span>
        </div>
        {problem && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-xs leading-relaxed text-error">{problem}</p>
            {onRetry && (
              <button
                type="button"
                className="text-xs font-bold text-primary-text hover:underline"
                onClick={onRetry}
              >
                {t('meeting.dev.retry')}
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Before entering the classroom — for everyone, on a laptop or a phone.
 *
 * Someone who will send (the teacher; anyone on a Daily class) checks their
 * camera and microphone here: a preview, a live level, which device, and a
 * plain reason (with "try again") when one cannot be used. A student on a
 * Darsly class enters listening; they may still test their devices here —
 * locally, nothing is sent and no call is opened — so that when the teacher
 * lets them speak, the right microphone is already chosen. Joining never
 * needs a camera or a microphone.
 *
 * Before the doors open the same screen is the waiting room: the countdown,
 * the devices, and the join button disabled with the reason — it opens by
 * itself when the server says so.
 */
export default function Lobby({
  session,
  listenOnly,
  isTeacher,
  ready,
  joining,
  waiting,
  skewMs = 0,
  onEnter,
  onBack,
}: {
  session: LobbySession;
  listenOnly: boolean;
  isTeacher: boolean;
  ready: boolean;
  joining: boolean;
  waiting?: LobbyWaiting | null;
  skewMs?: number;
  onEnter: (o: { mic: boolean; cam: boolean }) => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  // A listener's test is their choice; a sender's devices are checked at once.
  const [testing, setTesting] = useState(false);
  const devicesOn = !listenOnly || testing;
  const dev = useLobbyDevices(devicesOn);
  const now = useNow(!!waiting, skewMs);
  const problemText = (kind: 'cam' | 'mic', p: DeviceProblem | null) =>
    p ? t(`meeting.dev.${kind}.${p}`) : null;
  const opensIn = waiting ? countdown(waiting.opensAt, now) : null;
  const canJoin = ready && !joining && !waiting;

  const enter = () => {
    const choice = listenOnly
      ? { mic: false, cam: false }
      : { mic: dev.micOn && !dev.micProblem, cam: dev.camOn && !dev.camProblem };
    // The classroom opens the devices itself; the lobby lets go first.
    dev.release();
    setTesting(false);
    onEnter(choice);
  };

  const joinLabel = waiting
    ? waiting.code === 'NOT_OPEN_YET' && opensIn
      ? t('meeting.lobby.opensIn', { time: opensIn })
      : t('meeting.lobby.waitingTeacher')
    : joining
      ? t('meeting.joining')
      : listenOnly
        ? t('meeting.lobby.enterListening')
        : t('meeting.enter');

  const preview = (
    <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-zinc-900 sm:aspect-video">
      {dev.camOn && dev.preview ? (
        <Video track={dev.preview} muted mirror fit="cover" />
      ) : (
        <div className="grid h-full w-full place-items-center px-6 text-center">
          {dev.checking ? (
            <span className="text-sm text-zinc-300">{t('meeting.dev.checking')}</span>
          ) : (
            <span className="flex flex-col items-center gap-2 text-sm text-zinc-300">
              <span aria-hidden className="material-symbols-outlined text-4xl">
                videocam_off
              </span>
              {dev.camProblem ? t('meeting.dev.noPreview') : t('meeting.dev.camOffPreview')}
            </span>
          )}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
        <PreviewToggle
          on={dev.micOn}
          iconOn="mic"
          iconOff="mic_off"
          label={dev.micOn ? t('meeting.muteMic') : t('meeting.unmuteMic')}
          disabled={!dev.supported}
          onClick={() => dev.setMicOn(!dev.micOn)}
        />
        <PreviewToggle
          on={dev.camOn}
          iconOn="videocam"
          iconOff="videocam_off"
          label={dev.camOn ? t('meeting.camOff') : t('meeting.camOn')}
          disabled={!dev.supported}
          onClick={() => dev.setCamOn(!dev.camOn)}
        />
      </div>
    </div>
  );

  const devices = (
    <div className="divide-y divide-outline-variant/60 border-y border-outline-variant/60">
      <DeviceLine
        icon="videocam"
        title={t('meeting.dev.camera')}
        status={
          dev.camProblem
            ? t('meeting.dev.unavailable')
            : dev.camOn
              ? t('meeting.dev.on')
              : t('meeting.dev.off')
        }
        problem={problemText('cam', dev.camProblem)}
        onRetry={dev.camProblem === 'denied' || dev.camProblem === 'busy' ? dev.retry : undefined}
      >
        {dev.cameras.length > 1 && (
          <select
            className="input mt-2 py-2 text-sm"
            aria-label={t('meeting.dev.chooseCamera')}
            value={dev.prefs.cameraId ?? ''}
            onChange={(e) => dev.choose({ cameraId: e.target.value || undefined })}
          >
            <option value="">{t('meeting.dev.default')}</option>
            {dev.cameras.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${t('meeting.dev.camera')} ${i + 1}`}
              </option>
            ))}
          </select>
        )}
      </DeviceLine>
      <DeviceLine
        icon="mic"
        title={t('meeting.dev.microphone')}
        status={
          dev.micProblem ? (
            t('meeting.dev.unavailable')
          ) : dev.micOn ? (
            <span className="inline-flex items-center gap-2">
              <Meter level={dev.level} />
              {t('meeting.dev.on')}
            </span>
          ) : (
            t('meeting.dev.muted')
          )
        }
        problem={problemText('mic', dev.micProblem)}
        onRetry={dev.micProblem === 'denied' || dev.micProblem === 'busy' ? dev.retry : undefined}
      >
        {dev.mics.length > 1 && (
          <select
            className="input mt-2 py-2 text-sm"
            aria-label={t('meeting.dev.chooseMic')}
            value={dev.prefs.micId ?? ''}
            onChange={(e) => dev.choose({ micId: e.target.value || undefined })}
          >
            <option value="">{t('meeting.dev.default')}</option>
            {dev.mics.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${t('meeting.dev.microphone')} ${i + 1}`}
              </option>
            ))}
          </select>
        )}
      </DeviceLine>
    </div>
  );

  return (
    <div className="min-h-dvh bg-surface pb-28 text-on-surface sm:pb-8">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 pt-3 sm:px-6">
        <button type="button" className="btn-ghost px-3 text-on-surface-variant" onClick={onBack}>
          <span aria-hidden className="material-symbols-outlined text-[20px] rtl:rotate-180">
            arrow_back
          </span>
          {t('meeting.back')}
        </button>
        <ColorModeToggle />
      </header>
      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="mx-auto grid w-full max-w-5xl gap-6 px-4 pt-4 sm:px-6 lg:grid-cols-[1.3fr_1fr] lg:items-start lg:gap-10"
      >
        <div className="space-y-3 lg:order-2">
          <p className="text-xs font-bold text-primary-text">{t('meeting.brand')}</p>
          <h1 className="font-heading text-2xl font-bold leading-snug sm:text-3xl" dir="auto">
            {session.title}
          </h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-outline">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="material-symbols-outlined text-[18px]">
                schedule
              </span>
              {when(session.startsAt, i18n.language)}
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="material-symbols-outlined text-[18px]">
                timer
              </span>
              {t('live.minutes', { count: session.durationMin })}
            </span>
          </p>
          {waiting ? (
            <p
              className="flex items-start gap-2 rounded-xl bg-secondary-container/50 p-3 text-sm text-on-secondary-container"
              role="status"
            >
              <span aria-hidden className="material-symbols-outlined text-[20px]">
                hourglass_top
              </span>
              <span className="tabular-nums">
                {waiting.code === 'NOT_OPEN_YET' && opensIn
                  ? t('meeting.lobby.waitingOpen', { time: opensIn })
                  : t('meeting.lobby.waitingTeacherHint')}
              </span>
            </p>
          ) : (
            <p
              className="flex items-start gap-2 rounded-xl bg-secondary-container/50 p-3 text-sm text-on-secondary-container"
              role="status"
            >
              <span aria-hidden className="material-symbols-outlined text-[20px]">
                check_circle
              </span>
              {t('meeting.lobby.open')}
            </p>
          )}

          {listenOnly && (
            <ul className="space-y-3 pt-1">
              <li className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed text-primary-text"
                >
                  <span className="material-symbols-outlined text-[22px]">headphones</span>
                </span>
                <div>
                  <p className="font-semibold">{t('meeting.listenerTitle')}</p>
                  <p className="text-sm text-outline">{t('meeting.listenerHint')}</p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant"
                >
                  <span className="material-symbols-outlined text-[22px]">back_hand</span>
                </span>
                <div>
                  <p className="font-semibold">{t('meeting.raiseTitle')}</p>
                  <p className="text-sm text-outline">{t('meeting.raiseHint')}</p>
                </div>
              </li>
            </ul>
          )}
          {!isTeacher && !listenOnly && (
            <p className="text-xs text-outline">{t('meeting.dev.studentSendHint')}</p>
          )}

          <div className="hidden space-y-2 pt-2 sm:block">
            <button
              className="btn-primary w-full py-3 text-base"
              disabled={!canJoin}
              onClick={enter}
              aria-busy={joining || undefined}
            >
              <span aria-hidden className="material-symbols-outlined text-[20px]">
                {waiting ? 'schedule' : 'login'}
              </span>
              {joinLabel}
            </button>
          </div>
        </div>

        <div className="space-y-3 lg:order-1">
          {devicesOn ? (
            <>
              {preview}
              {devices}
              {listenOnly && (
                <button
                  type="button"
                  className="text-sm font-semibold text-on-surface-variant hover:underline"
                  onClick={() => setTesting(false)}
                >
                  {t('meeting.lobby.stopTest')}
                </button>
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5">
              <p className="font-heading font-bold">{t('meeting.lobby.testTitle')}</p>
              <p className="mt-1 text-sm text-on-surface-variant">{t('meeting.lobby.testHint')}</p>
              <button type="button" className="btn-ghost mt-3" onClick={() => setTesting(true)}>
                <span aria-hidden className="material-symbols-outlined text-base">
                  settings_voice
                </span>
                {t('meeting.lobby.testButton')}
              </button>
            </div>
          )}
        </div>
      </m.div>

      {/* On a phone the way in stays under the thumb, whatever is scrolled. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-outline-variant bg-surface-container-lowest px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:hidden">
        <button
          className="btn-primary w-full py-3 text-base"
          disabled={!canJoin}
          onClick={enter}
          aria-busy={joining || undefined}
        >
          <span aria-hidden className="material-symbols-outlined text-[20px]">
            {waiting ? 'schedule' : 'login'}
          </span>
          {joinLabel}
        </button>
      </div>
    </div>
  );
}

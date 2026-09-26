import { m } from 'framer-motion';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLobbyDevices, type DeviceProblem } from '../../../lib/liveDevices';
import { Video } from './media';

export interface LobbySession {
  title: string;
  startsAt: string;
  durationMin: number;
}

function when(iso: string, lang: string) {
  return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A round control on the preview — the two a teacher actually touches here. */
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
        on ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-red-600 text-white hover:bg-red-500'
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
  children,
}: {
  icon: string;
  title: string;
  status: React.ReactNode;
  problem: string | null;
  children?: React.ReactNode;
}) {
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
        {problem && <p className="mt-1 text-xs leading-relaxed text-error">{problem}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * Before entering the classroom.
 *
 * Someone who will send (the teacher; anyone on a Daily class) checks their
 * camera and microphone here — a preview, a live level, which device, and a
 * plain reason when one cannot be used. A student entering a Darsly class
 * listens first: nothing is asked of their devices, and the lobby says so.
 */
export default function Lobby({
  session,
  listenOnly,
  isTeacher,
  ready,
  joining,
  onEnter,
  onBack,
}: {
  session: LobbySession;
  listenOnly: boolean;
  isTeacher: boolean;
  ready: boolean;
  joining: boolean;
  onEnter: (o: { mic: boolean; cam: boolean }) => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const dev = useLobbyDevices(!listenOnly);
  const [, force] = useState(0);
  const problemText = (kind: 'cam' | 'mic', p: DeviceProblem | null) =>
    p ? t(`meeting.dev.${kind}.${p}`) : null;

  const enter = () => {
    const choice = { mic: dev.micOn && !dev.micProblem, cam: dev.camOn && !dev.camProblem };
    // The classroom opens the devices itself; the lobby lets go first.
    dev.release();
    force((n) => n + 1);
    onEnter(choice);
  };

  const meta = (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-outline">
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="material-symbols-outlined text-[18px]">schedule</span>
        {when(session.startsAt, i18n.language)}
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="material-symbols-outlined text-[18px]">timer</span>
        {t('live.minutes', { count: session.durationMin })}
      </span>
    </p>
  );

  const actions = (
    <div className="mt-6 space-y-2">
      <button
        className="btn-primary w-full py-3 text-base"
        disabled={!ready || joining}
        onClick={enter}
        aria-busy={joining || undefined}
      >
        {joining ? (
          <>
            <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary motion-reduce:animate-none" />
            {t('meeting.joining')}
          </>
        ) : (
          <>
            <span aria-hidden className="material-symbols-outlined text-[20px]">login</span>
            {t('meeting.enter')}
          </>
        )}
      </button>
      <button type="button" className="btn-ghost w-full text-on-surface-variant" onClick={onBack}>
        {t('meeting.back')}
      </button>
    </div>
  );

  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4 py-8 sm:px-6">
      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className={`grid w-full items-center gap-8 ${listenOnly ? 'max-w-md' : 'max-w-5xl lg:grid-cols-[1.4fr_1fr] lg:gap-12'}`}
      >
        {!listenOnly && (
          <div>
            <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-900">
              {dev.camOn && dev.preview ? (
                <Video track={dev.preview} muted mirror fit="cover" />
              ) : (
                <div className="grid h-full w-full place-items-center px-6 text-center">
                  {dev.checking ? (
                    <span className="text-sm text-zinc-400">{t('meeting.dev.checking')}</span>
                  ) : (
                    <span className="flex flex-col items-center gap-2 text-sm text-zinc-400">
                      <span aria-hidden className="material-symbols-outlined text-4xl">videocam_off</span>
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
          </div>
        )}

        <div className={listenOnly ? 'rounded-xl border border-outline-variant bg-surface-container-lowest p-6 sm:p-8' : ''}>
          <p className="text-xs font-bold text-primary-text">{t('meeting.brand')}</p>
          <h1 className="mt-1 font-heading text-2xl font-bold leading-snug sm:text-3xl" dir="auto">
            {session.title}
          </h1>
          {meta}

          {listenOnly ? (
            <ul className="mt-6 space-y-4">
              <li className="flex items-start gap-3">
                <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed text-primary-text">
                  <span className="material-symbols-outlined text-[22px]">headphones</span>
                </span>
                <div>
                  <p className="font-semibold">{t('meeting.listenerTitle')}</p>
                  <p className="text-sm text-outline">{t('meeting.listenerHint')}</p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
                  <span className="material-symbols-outlined text-[22px]">back_hand</span>
                </span>
                <div>
                  <p className="font-semibold">{t('meeting.raiseTitle')}</p>
                  <p className="text-sm text-outline">{t('meeting.raiseHint')}</p>
                </div>
              </li>
            </ul>
          ) : (
            <div className="mt-5 divide-y divide-outline-variant/60 border-y border-outline-variant/60">
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
          )}

          {!isTeacher && !listenOnly && (
            <p className="mt-3 text-xs text-outline">{t('meeting.dev.studentSendHint')}</p>
          )}
          {actions}
        </div>
      </m.div>
    </div>
  );
}

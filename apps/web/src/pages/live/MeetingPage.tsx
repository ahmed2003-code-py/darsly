import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { useDailyMeeting, type Participant } from '../../lib/useDailyMeeting';
import { useAuthStore } from '../../stores/auth';
import { Spinner } from '../../components/ui';

/**
 * The Darsly classroom.
 *
 * Deliberately outside the app's normal chrome: no sidebar, no bottom bar, no
 * top bar. A phone in a class has one job, and every row of navigation is a row
 * the video does not get. The layout is built from the small screen up for the
 * same reason — most of these students are on an Android phone, and a desktop
 * grid scaled down is not a mobile interface.
 */

/** Paints one participant's video track onto a real <video> element. */
function Video({ track, muted, mirror }: { track: MediaStreamTrack | null; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!track) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([track]);
    // Autoplay can be refused; there is nothing useful to do about it but not
    // crash the class over a promise rejection.
    void el.play().catch(() => undefined);
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full object-cover ${mirror ? '-scale-x-100' : ''}`}
    />
  );
}

function Initial({ name }: { name: string }) {
  return (
    <div className="grid h-full w-full place-items-center bg-surface-container">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-primary-fixed font-heading text-2xl font-extrabold text-on-primary-fixed">
        {name.trim().charAt(0) || '؟'}
      </span>
    </div>
  );
}

function Tile({
  p,
  teacherId,
  big,
}: {
  p: Participant;
  teacherId: string | null;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const isTeacher = p.owner || (!!teacherId && p.userId === teacherId);
  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-surface-container-lowest ring-1 ring-outline-variant/40 ${
        big ? 'aspect-video w-full' : 'aspect-[4/3]'
      }`}
    >
      {p.video && p.track ? <Video track={p.track} muted={p.local} mirror={p.local} /> : <Initial name={p.name} />}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-2">
        {!p.audio && <span className="material-symbols-outlined text-[16px] text-error">mic_off</span>}
        <span className="truncate text-xs font-bold text-white">
          {p.local ? t('meeting.you') : p.name}
        </span>
        {isTeacher && (
          <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-on-primary">
            {t('meeting.teacherBadge')}
          </span>
        )}
      </div>
    </div>
  );
}

/** One control. Round, large enough for a thumb, and labelled for screen readers. */
function Ctl({
  icon,
  on,
  danger,
  label,
  onClick,
}: {
  icon: string;
  on?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid h-12 w-12 shrink-0 place-items-center rounded-full transition active:scale-95 sm:h-11 sm:w-11 ${
        danger
          ? 'bg-error text-on-error'
          : on
            ? 'bg-surface-container-highest text-on-surface'
            : 'bg-error-container text-on-error-container'
      }`}
    >
      <span className="material-symbols-outlined text-[22px]">{icon}</span>
    </button>
  );
}

export default function MeetingPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isTeacher = user?.role === Role.TEACHER;
  const [ready, setReady] = useState(false);
  const [wantMic, setWantMic] = useState(true);
  const [wantCam, setWantCam] = useState(true);
  const [showPeople, setShowPeople] = useState(false);
  const meeting = useDailyMeeting(id);

  /**
   * The server decides everything: whether this person may enter, which room,
   * and with what powers. The page only asks.
   */
  const entry = useQuery({
    queryKey: ['live-entry', id, isTeacher],
    queryFn: async () =>
      (await api.get(isTeacher ? `/teacher/live/${id}/join` : `/live/${id}/join`)).data,
    retry: false,
  });

  const end = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${id}/end`)).data,
    onSuccess: () => navigate(isTeacher ? '/teacher/live' : '/live', { replace: true }),
  });

  useEffect(() => {
    if (entry.data && meeting.ready && !ready) void meeting.startPreview();
  }, [entry.data, meeting.ready, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // A session pointed at Zoom is not a Darsly classroom; send them there and
  // leave, rather than showing an empty room.
  useEffect(() => {
    if (entry.data?.externalUrl) {
      window.location.replace(entry.data.externalUrl);
    }
  }, [entry.data]);

  const leaveAndGo = async () => {
    await meeting.leave();
    navigate(isTeacher ? '/teacher/live' : '/live', { replace: true });
  };

  if (entry.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <Spinner />
      </div>
    );
  }

  if (entry.isError) {
    const code = (entry.error as any)?.response?.data?.code;
    const msg =
      code && ['NOT_OPEN_YET', 'ENDED', 'NOT_STARTED', 'LIVE_NOT_CONFIGURED', 'LIVE_PROVIDER_UNREACHABLE', 'LIVE_PROVIDER_ERROR'].includes(code)
        ? t(`meeting.err.${code}`)
        : t('meeting.err.GENERIC');
    return (
      <div className="grid min-h-dvh place-items-center bg-surface px-6">
        <div className="w-full max-w-sm text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-outline">videocam_off</span>
          <p className="mb-6 font-heading text-lg font-bold">{msg}</p>
          <button className="btn-primary w-full" onClick={() => navigate(isTeacher ? '/teacher/live' : '/live')}>
            {t('meeting.back')}
          </button>
        </div>
      </div>
    );
  }

  const session = entry.data.session;
  const amOwner = entry.data.participant.role === 'TEACHER';
  const teacherId = amOwner ? (user?.id ?? null) : null;

  // ── Pre-join ──────────────────────────────────────────────────────────────
  if (!ready) {
    const me = meeting.participants.find((p) => p.local);
    return (
      <div className="grid min-h-dvh place-items-center bg-surface px-5 py-8">
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md"
        >
          <p className="mb-1 text-center text-xs font-bold uppercase tracking-widest text-primary">
            {t('meeting.brand')}
          </p>
          <h1 className="mb-5 text-center font-heading text-2xl font-extrabold">{session.title}</h1>

          <div className="relative mb-5 aspect-video overflow-hidden rounded-2xl bg-surface-container ring-1 ring-outline-variant/40">
            {wantCam && me?.track ? (
              <Video track={me.track} muted mirror />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <span className="material-symbols-outlined text-4xl text-outline">videocam_off</span>
              </div>
            )}
          </div>

          <div className="mb-5 flex justify-center gap-3">
            <Ctl icon={wantMic ? 'mic' : 'mic_off'} on={wantMic} label={t('meeting.mic')} onClick={() => setWantMic((v) => !v)} />
            <Ctl icon={wantCam ? 'videocam' : 'videocam_off'} on={wantCam} label={t('meeting.cam')} onClick={() => setWantCam((v) => !v)} />
          </div>

          <button
            className="btn-primary w-full py-3"
            disabled={!meeting.ready}
            onClick={async () => {
              await meeting.join(entry.data.meeting.url, entry.data.meeting.token, { mic: wantMic, cam: wantCam });
              setReady(true);
            }}
          >
            <span className="material-symbols-outlined">login</span>
            {t('meeting.enter')}
          </button>
          <button className="mt-2 w-full py-2 text-sm text-outline hover:text-on-surface" onClick={leaveAndGo}>
            {t('meeting.back')}
          </button>
        </m.div>
      </div>
    );
  }

  // ── In the room ───────────────────────────────────────────────────────────
  const others = meeting.participants.filter((p) => !p.local);
  const me = meeting.participants.find((p) => p.local);
  const screener = meeting.participants.find((p) => p.screen && p.screenTrack);
  // Whoever is talking to the class gets the big frame: the shared screen if
  // there is one, else the teacher, else whoever else is here.
  const stage = screener ?? others.find((p) => p.owner) ?? others[0] ?? me;

  return (
    // `h-dvh`, not `min-h-dvh`: the stage is a flex child that has to fill the
    // space left over, and a min-height leaves its height indefinite — which
    // renders the video at its own intrinsic size with the rest of the screen
    // blank under it.
    <div className="flex h-dvh flex-col overflow-hidden bg-surface">
      <header className="flex items-center gap-3 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="flex items-center gap-1.5 rounded-full bg-error/15 px-2.5 py-1">
          <span className="h-2 w-2 animate-pulse rounded-full bg-error" />
          <span className="text-[11px] font-extrabold text-error">{t('meeting.live')}</span>
        </span>
        <h1 className="min-w-0 flex-1 truncate font-heading text-sm font-bold">{session.title}</h1>
        <button
          className="flex items-center gap-1 rounded-full bg-surface-container px-2.5 py-1 text-xs font-bold"
          onClick={() => setShowPeople((v) => !v)}
        >
          <span className="material-symbols-outlined text-[16px]">group</span>
          {meeting.participants.length}
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-2">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-surface-container-lowest ring-1 ring-outline-variant/40">
          {screener ? (
            <Video track={screener.screenTrack} muted />
          ) : stage && stage.video && stage.track ? (
            <Video track={stage.track} muted={stage.local} mirror={stage.local} />
          ) : (
            <Initial name={stage?.name ?? ''} />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
            <span className="text-xs font-bold text-white">
              {screener ? t('meeting.sharingScreen', { name: screener.name }) : (stage?.local ? t('meeting.you') : stage?.name ?? '')}
            </span>
          </div>
        </div>

        {/* The filmstrip. Scrolls sideways rather than shrinking faces to nothing. */}
        {meeting.participants.length > 1 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
            {meeting.participants
              .filter((p) => p.sessionId !== stage?.sessionId)
              .map((p) => (
                <div key={p.sessionId} className="w-28 shrink-0 sm:w-36">
                  <Tile p={p} teacherId={teacherId} />
                </div>
              ))}
          </div>
        )}
      </main>

      {/* Controls sit above the home indicator, always reachable with a thumb. */}
      <footer className="flex flex-wrap items-center justify-center gap-2.5 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
        <Ctl icon={meeting.micOn ? 'mic' : 'mic_off'} on={meeting.micOn} label={t('meeting.mic')} onClick={meeting.toggleMic} />
        <Ctl icon={meeting.camOn ? 'videocam' : 'videocam_off'} on={meeting.camOn} label={t('meeting.cam')} onClick={meeting.toggleCam} />
        <Ctl icon="present_to_all" on={!meeting.sharing} label={t('meeting.share')} onClick={meeting.toggleShare} />
        <Ctl icon="group" on label={t('meeting.people')} onClick={() => setShowPeople((v) => !v)} />
        <Ctl icon="call_end" danger label={t('meeting.leave')} onClick={leaveAndGo} />
        {amOwner && (
          <button
            className="rounded-full bg-error-container px-4 py-3 text-xs font-extrabold text-on-error-container sm:py-2.5"
            onClick={() => window.confirm(t('meeting.endConfirm')) && end.mutate()}
          >
            {t('meeting.endForAll')}
          </button>
        )}
      </footer>

      {/* People sheet — a drawer on the phone, which is where it belongs. */}
      <AnimatePresence>
        {showPeople && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-on-surface/40"
            onClick={() => setShowPeople(false)}
          >
            <m.aside
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-3xl bg-surface-container-lowest p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-outline-variant" />
              <h2 className="mb-3 font-heading text-base font-bold">
                {t('meeting.peopleCount', { count: meeting.participants.length })}
              </h2>
              <ul className="divide-y divide-outline-variant/40">
                {meeting.participants.map((p) => (
                  <li key={p.sessionId} className="flex items-center gap-3 py-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-fixed font-bold text-on-primary-fixed">
                      {p.name.trim().charAt(0) || '؟'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-bold">
                      {p.local ? t('meeting.you') : p.name}
                    </span>
                    {!p.audio && <span className="material-symbols-outlined text-[18px] text-outline">mic_off</span>}
                    {/* Moderation is the owner's, and only the server can make
                        someone one. */}
                    {amOwner && !p.local && (
                      <>
                        <button
                          className="rounded-full p-1.5 text-outline hover:text-on-surface"
                          aria-label={t('meeting.muteOne')}
                          onClick={() => meeting.muteParticipant(p.sessionId)}
                        >
                          <span className="material-symbols-outlined text-[18px]">mic_off</span>
                        </button>
                        <button
                          className="rounded-full p-1.5 text-error/70 hover:text-error"
                          aria-label={t('meeting.removeOne')}
                          onClick={() => window.confirm(t('meeting.removeConfirm', { name: p.name })) && meeting.removeParticipant(p.sessionId)}
                        >
                          <span className="material-symbols-outlined text-[18px]">person_remove</span>
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </m.aside>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

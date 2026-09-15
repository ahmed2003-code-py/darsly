import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { useDailyMeeting, type Participant } from '../../lib/useDailyMeeting';
import { useLiveChat } from '../../lib/useLiveChat';
import { useAuthStore } from '../../stores/auth';
import { getSocket } from '../../lib/socket';
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

/**
 * One control. Round, thumb-sized, and its state readable at a glance.
 *
 * Four states rather than two, because they mean different things: neutral is
 * "on and unremarkable", `off` is muted or dark (red, because it is the one
 * you need to notice), `active` is doing something right now (screen share),
 * and `dim` is a control this device cannot offer at all.
 */
function Ctl({
  icon,
  off,
  active,
  dim,
  danger,
  label,
  onClick,
}: {
  icon: string;
  off?: boolean;
  active?: boolean;
  dim?: boolean;
  danger?: boolean;
  label: string;
  onClick: () => void;
}) {
  const tone = danger
    ? 'bg-error text-on-error shadow-sm'
    : dim
      ? 'bg-surface-container text-outline/60'
      : active
        ? 'bg-primary text-on-primary'
        : off
          ? 'bg-error-container text-on-error-container'
          : 'bg-surface-container-highest text-on-surface';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active ?? !off}
      title={label}
      className={`grid h-12 w-12 shrink-0 place-items-center rounded-full transition active:scale-95 ${tone}`}
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
  const [showChat, setShowChat] = useState(false);
  const [draft, setDraft] = useState('');
  const meeting = useDailyMeeting(id);
  const chat = useLiveChat(id, showChat);
  const feedRef = useRef<HTMLDivElement>(null);

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

  /**
   * Recording starts in the browser, because that is where Daily's owner token
   * is. The server is told so the session carries the state and the id — the
   * page is not the record of anything.
   */
  const recording = useMutation({
    mutationFn: async (startIt: boolean) => {
      if (startIt) {
        const id2 = await meeting.startRecording();
        return (await api.post(`/teacher/live/${id}/recording/start`, { recordingId: id2 ?? undefined })).data;
      }
      await meeting.stopRecording();
      return (await api.post(`/teacher/live/${id}/recording/stop`)).data;
    },
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

  useEffect(() => {
    if (showChat) feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [chat.messages.length, showChat]);

  /**
   * The teacher ended it.
   *
   * Two ways to learn that, because either can arrive first: the socket says
   * so, and the room disappearing underneath drops the connection. Whichever
   * comes first, the student is told rather than left in an empty meeting —
   * which is exactly what happened before, and reads as the app freezing.
   */
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onEnded = (p: { sessionId: string }) => {
      if (p?.sessionId === id) meeting.setEnded(true);
    };
    sock.on('live:ended', onEnded);
    return () => { sock.off('live:ended', onEnded); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const leaveAndGo = async () => {
    await meeting.leave();
    navigate(isTeacher ? '/teacher/live' : '/live', { replace: true });
  };

  if (meeting.ended) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface px-6">
        <div className="w-full max-w-sm text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-outline">waving_hand</span>
          <p className="mb-1 font-heading text-lg font-bold">{t('meeting.endedTitle')}</p>
          <p className="mb-6 text-sm text-outline">{t('meeting.endedHint')}</p>
          <button
            className="btn-primary w-full"
            onClick={() => navigate(isTeacher ? '/teacher/live' : '/live', { replace: true })}
          >
            {t('meeting.back')}
          </button>
        </div>
      </div>
    );
  }

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
            <Ctl icon={wantMic ? 'mic' : 'mic_off'} off={!wantMic} label={t('meeting.mic')} onClick={() => setWantMic((v) => !v)} />
            <Ctl icon={wantCam ? 'videocam' : 'videocam_off'} off={!wantCam} label={t('meeting.cam')} onClick={() => setWantCam((v) => !v)} />
          </div>

          <button
            className="btn-primary w-full py-3"
            disabled={!meeting.ready}
            onClick={async () => {
              await meeting.join(entry.data.meeting.url, entry.data.meeting.token, {
                mic: wantMic,
                cam: wantCam,
                owner: entry.data.participant.role === 'TEACHER',
              });
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
        {/* Visible to everyone, not only the teacher who started it: being
            recorded is something a class is entitled to know at a glance. */}
        {meeting.recording && (
          <span className="flex items-center gap-1 rounded-full bg-error px-2 py-0.5 text-[10px] font-extrabold text-on-error">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            REC
          </span>
        )}
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

          {/* Alone. Says what is happening instead of showing a dark rectangle
              and letting the teacher wonder whether it is broken. */}
          {others.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center">
              <div className="mx-auto max-w-xs rounded-2xl bg-on-surface/55 px-4 py-3 backdrop-blur-sm">
                <p className="font-heading text-sm font-bold text-surface">
                  {amOwner ? t('meeting.waitingStudents') : t('meeting.waitingTeacherInRoom')}
                </p>
              </div>
            </div>
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

      <AnimatePresence>
        {meeting.notice && (
          <m.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-3 mb-1 rounded-xl bg-on-surface/85 px-3 py-2 text-center text-xs font-bold text-surface"
          >
            {t(`meeting.notice.${meeting.notice}`)}
          </m.p>
        )}
      </AnimatePresence>

      {/* Controls sit above the home indicator, always reachable with a thumb. */}
      <footer className="flex flex-wrap items-center justify-center gap-2.5 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
        <Ctl icon={meeting.micOn ? 'mic' : 'mic_off'} off={!meeting.micOn} label={t('meeting.mic')} onClick={meeting.toggleMic} />
        <Ctl icon={meeting.camOn ? 'videocam' : 'videocam_off'} off={!meeting.camOn} label={t('meeting.cam')} onClick={meeting.toggleCam} />
        {/* Dimmed rather than hidden on a phone: a teacher who expects to share
            should be told their device cannot, not left hunting for a button. */}
        <Ctl
          icon={meeting.sharing ? 'cancel_presentation' : 'present_to_all'}
          active={meeting.sharing}
          dim={!meeting.canShare}
          label={meeting.canShare ? t('meeting.share') : t('meeting.shareUnsupported')}
          onClick={meeting.toggleShare}
        />
        <div className="relative">
          <Ctl icon="chat" label={t('meeting.chat')} onClick={() => setShowChat((v) => !v)} />
          {chat.unread > 0 && !showChat && (
            <span className="absolute -end-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-error px-1 text-[10px] font-bold text-on-error">
              {chat.unread > 9 ? '9+' : chat.unread}
            </span>
          )}
        </div>
        <Ctl icon="group" label={t('meeting.people')} onClick={() => setShowPeople((v) => !v)} />
        {amOwner && (
          <Ctl
            icon="radio_button_checked"
            active={meeting.recording}
            label={meeting.recording ? t('meeting.stopRec') : t('meeting.startRec')}
            onClick={() => recording.mutate(!meeting.recording)}
          />
        )}
        <Ctl icon="call_end" danger label={t('meeting.leave')} onClick={leaveAndGo} />
        {amOwner && (
          <button
            className="h-12 rounded-full bg-error-container px-4 text-xs font-extrabold text-on-error-container transition active:scale-95"
            onClick={() => window.confirm(t('meeting.endConfirm')) && end.mutate()}
          >
            {t('meeting.endForAll')}
          </button>
        )}
      </footer>

      {/* Chat. A sheet rather than a sidebar: on the screen most of this class
          is on, a column beside the video is a column neither of them can use. */}
      <AnimatePresence>
        {showChat && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-on-surface/40"
            onClick={() => setShowChat(false)}
          >
            <m.aside
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-surface-container-lowest"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 px-4 pt-3">
                <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-outline-variant" />
                <h2 className="mb-2 font-heading text-base font-bold">{t('meeting.chat')}</h2>
              </div>

              <div ref={feedRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-2">
                {chat.messages.length === 0 ? (
                  <p className="py-10 text-center text-sm text-outline">{t('meeting.chatEmpty')}</p>
                ) : (
                  chat.messages.map((msg) => {
                    const mine = msg.senderId === user?.id;
                    return (
                      <div key={msg.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                            mine ? 'bg-primary text-on-primary' : 'bg-surface-container'
                          }`}
                        >
                          {!mine && (
                            <p className="mb-0.5 text-[11px] font-bold text-primary">
                              {msg.senderName}
                              {msg.senderRole === 'TEACHER' && ` · ${t('meeting.teacherBadge')}`}
                            </p>
                          )}
                          <p className="whitespace-pre-wrap break-words text-sm" dir="auto">{msg.body}</p>
                          <p className={`mt-0.5 text-[10px] ${mine ? 'text-on-primary/70' : 'text-outline'}`}>
                            {new Date(msg.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <form
                className="flex shrink-0 items-center gap-2 border-t border-outline-variant/40 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = draft;
                  setDraft('');
                  void chat.send(text);
                }}
              >
                <input
                  className="input flex-1"
                  dir="auto"
                  value={draft}
                  maxLength={2000}
                  placeholder={t('meeting.chatPh')}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  type="submit"
                  aria-label={t('meeting.send')}
                  disabled={!draft.trim() || chat.sending}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary disabled:opacity-40"
                >
                  <span className="material-symbols-outlined text-[20px] rtl:-scale-x-100">send</span>
                </button>
              </form>
            </m.aside>
          </m.div>
        )}
      </AnimatePresence>

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

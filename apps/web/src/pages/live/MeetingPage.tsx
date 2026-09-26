import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { useLiveMeeting, type LiveProvider } from '../../lib/useLiveMeeting';
import { useAuthStore } from '../../stores/auth';
import { getSocket } from '../../lib/socket';
import { resolveError } from '../../lib/errorMessage';
import { useClockAnchor, type SessionTiming } from '../../lib/useSessionClock';
import Lobby from './meeting/Lobby';
import Classroom from './meeting/Classroom';

/** What one press of the teacher's button adds. */
const EXTEND_MINUTES = 15;

/** A full-screen state: loading, refused, ended. Calm, one message, one way out. */
function StateScreen({
  icon,
  title,
  hint,
  action,
  onAction,
  busy,
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-6" aria-busy={busy || undefined}>
      <div className="w-full max-w-sm text-center">
        <span
          aria-hidden
          className={`material-symbols-outlined mb-3 text-5xl text-outline ${busy ? 'motion-safe:animate-pulse' : ''}`}
        >
          {icon}
        </span>
        <p className="font-heading text-lg font-bold">{title}</p>
        {hint && <p className="mt-1 text-sm text-outline">{hint}</p>}
        {action && onAction && (
          <button className="btn-primary mt-6 w-full" onClick={onAction}>
            {action}
          </button>
        )}
      </div>
    </div>
  );
}

const KNOWN_ERRORS = [
  'NOT_OPEN_YET',
  'ENDED',
  'NOT_STARTED',
  'LIVE_NOT_CONFIGURED',
  'LIVE_PROVIDER_UNREACHABLE',
  'LIVE_PROVIDER_ERROR',
  'LIVE_RTC_REJECTED',
];

/**
 * The Darsly classroom.
 *
 * This page decides nothing: the server says whether this person may enter,
 * which provider carries the class and with what powers (the join answer),
 * and the meeting hook carries the media. The page holds the timing anchor,
 * the room's events and the three teacher actions — extend, record, end — and
 * hands the drawing to the lobby and the classroom.
 */
export default function MeetingPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isTeacher = user?.role === Role.TEACHER;
  const [inRoom, setInRoom] = useState(false);
  const [joining, setJoining] = useState(false);
  const clock = useClockAnchor();
  const [extendNote, setExtendNote] = useState<string | null>(null);
  const home = isTeacher ? '/teacher/live' : '/live';

  const entry = useQuery({
    queryKey: ['live-entry', id, isTeacher],
    queryFn: async () =>
      (await api.get(isTeacher ? `/teacher/live/${id}/join` : `/live/${id}/join`)).data,
    retry: false,
  });
  const provider: LiveProvider | null = entry.data?.meeting?.provider ?? null;
  const meeting = useLiveMeeting(id, provider, { onTiming: clock.apply });
  const setEnded = meeting.setEnded;
  const amOwner = entry.data?.participant?.role === 'TEACHER';
  /** A Cloudflare student enters listening: no preview, no devices asked for. */
  const listenOnly = meeting.provider === 'cloudflare' && !!entry.data && !amOwner;

  const recording = useMutation({
    mutationFn: async (startIt: boolean) => {
      if (startIt) {
        const rid = await meeting.startRecording();
        return (await api.post(`/teacher/live/${id}/recording/start`, { recordingId: rid ?? undefined })).data;
      }
      await meeting.stopRecording();
      return (await api.post(`/teacher/live/${id}/recording/stop`)).data;
    },
    onError: (e) => setExtendNote(resolveError(e).message || t('meeting.notice.RECORDING_FAILED')),
  });

  /** "+15 minutes", done by the server; nothing on screen moves until it answers. */
  const extend = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/teacher/live/${id}/extend`, {
          minutes: EXTEND_MINUTES,
          ...(clock.anchor ? { expectedEndsAt: new Date(clock.anchor.endsAt).toISOString() } : {}),
        })
      ).data as SessionTiming,
    onSuccess: (timing) => {
      clock.apply(timing);
      setExtendNote(t('meeting.extended'));
    },
    onError: (e: any) => {
      const { code, message } = resolveError(e);
      if (code === 'TIMING_CHANGED' && e?.response?.data?.timing) {
        clock.apply(e.response.data.timing);
        setExtendNote(t('meeting.extendAlready'));
      } else {
        setExtendNote(message || t('meeting.extendFailed'));
      }
    },
  });
  useEffect(() => {
    if (!extendNote) return;
    const h = setTimeout(() => setExtendNote(null), 4500);
    return () => clearTimeout(h);
  }, [extendNote]);

  // The join answer carries the current timing — an extension made while this
  // page was closed is already in it.
  useEffect(() => {
    if (entry.data?.session) clock.apply(entry.data.session);
  }, [entry.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onTiming = (p: SessionTiming & { sessionId: string }) => {
      if (p?.sessionId === id) clock.apply(p);
    };
    sock.on('live:timing-updated', onTiming);
    return () => {
      sock.off('live:timing-updated', onTiming);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const end = useMutation({
    mutationFn: async () => (await api.post(`/teacher/live/${id}/end`)).data,
    onSuccess: () => navigate(home, { replace: true }),
    onError: (e) => setExtendNote(resolveError(e).message),
  });

  // A session pointed at Zoom is not a Darsly classroom: send them there.
  useEffect(() => {
    if (entry.data?.externalUrl) window.location.replace(entry.data.externalUrl);
  }, [entry.data]);

  // Ended — by the teacher, the clock, or a cancellation. Bound again once the
  // provider is known, so it marks the adapter actually in use.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onEnded = (p: { sessionId: string }) => {
      if (p?.sessionId === id) setEnded(true);
    };
    sock.on('live:ended', onEnded);
    return () => {
      sock.off('live:ended', onEnded);
    };
  }, [id, setEnded]);

  const leave = async () => {
    await meeting.leave();
    navigate(home, { replace: true });
  };

  const enter = async (o: { mic: boolean; cam: boolean }) => {
    setJoining(true);
    try {
      const m = entry.data.meeting;
      if (meeting.provider === 'cloudflare') {
        await meeting.join(m, { mic: o.mic, cam: o.cam, owner: amOwner });
      } else {
        await meeting.join(m.url, m.token, { mic: o.mic, cam: o.cam, owner: amOwner, language: m.language });
      }
      setInRoom(true);
    } finally {
      setJoining(false);
    }
  };

  if (meeting.ended) {
    return (
      <StateScreen
        icon="waving_hand"
        title={t('meeting.endedTitle')}
        hint={t('meeting.endedHint')}
        action={t('meeting.back')}
        onAction={() => navigate(home, { replace: true })}
      />
    );
  }
  if (entry.isLoading || entry.data?.externalUrl) {
    return <StateScreen icon="videocam" title={t('meeting.preparing')} busy />;
  }
  if (entry.isError) {
    const code = (entry.error as any)?.response?.data?.code;
    const known = code && KNOWN_ERRORS.includes(code);
    return (
      <StateScreen
        icon={code === 'ENDED' ? 'event_busy' : code === 'NOT_STARTED' || code === 'NOT_OPEN_YET' ? 'schedule' : 'videocam_off'}
        title={known ? t(`meeting.err.${code}`) : t('meeting.err.GENERIC')}
        action={t('meeting.back')}
        onAction={() => navigate(home)}
      />
    );
  }

  const session = entry.data.session;

  if (!inRoom) {
    return (
      <Lobby
        session={session}
        listenOnly={listenOnly}
        isTeacher={amOwner}
        ready={meeting.ready}
        joining={joining}
        onEnter={(o) => void enter(o)}
        onBack={() => void leave()}
      />
    );
  }

  return (
    <Classroom
      sessionId={id}
      title={session.title}
      userId={user?.id ?? null}
      amOwner={amOwner}
      meeting={meeting}
      anchor={clock.anchor}
      extend={{ run: () => extend.mutate(), pending: extend.isPending, note: extendNote }}
      recording={{
        active: meeting.recording,
        pending: recording.isPending,
        toggle: () => recording.mutate(!meeting.recording),
      }}
      onLeave={() => void leave()}
      onEndClass={() => end.mutate()}
      ending={end.isPending}
    />
  );
}

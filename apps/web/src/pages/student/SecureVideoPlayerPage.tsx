import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PlaybackTicket } from '@darsly/shared-types';
import RovingWatermark from '../../components/RovingWatermark';
import { Badge, Spinner } from '../../components/ui';
import { api, apiOrigin } from '../../lib/api';
import { duration } from '../../lib/format';
import { useObscureAndDevtools, useNoCopyGuards } from '../../lib/player-hardening';

type Tab = 'notes' | 'attachments' | 'qa';

export default function SecureVideoPlayerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastHeartbeat = useRef(0);

  const [ticket, setTicket] = useState<PlaybackTicket | null>(null);
  const [error, setError] = useState('');
  const [obscured, setObscured] = useState(false);
  const [tab, setTab] = useState<Tab>('notes');
  const [noteBody, setNoteBody] = useState('');

  // ── Course curriculum (sidebar) + current lesson meta ────────────────────
  const { data: course, isLoading } = useQuery({
    queryKey: ['course', courseId],
    queryFn: async () => (await api.get(`/courses/${courseId}`)).data,
  });
  const flatLessons: any[] = course?.units.flatMap((u: any) => u.lessons) ?? [];
  const current = flatLessons.find((l) => l.id === lessonId);
  const idx = flatLessons.findIndex((l) => l.id === lessonId);
  const nextLesson = flatLessons.slice(idx + 1).find((l) => !l.locked);

  // ── Notes ────────────────────────────────────────────────────────────────
  const { data: notes } = useQuery({
    queryKey: ['notes', lessonId],
    queryFn: async () => (await api.get(`/playback/lessons/${lessonId}/notes`)).data,
    enabled: !!lessonId,
  });
  const addNote = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/playback/lessons/${lessonId}/notes`, {
          timestampSec: Math.floor(videoRef.current?.currentTime ?? 0),
          body: noteBody.trim(),
        })
      ).data,
    onSuccess: () => {
      setNoteBody('');
      queryClient.invalidateQueries({ queryKey: ['notes', lessonId] });
    },
  });
  const delNote = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/playback/notes/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes', lessonId] }),
  });

  // ── Client hardening ─────────────────────────────────────────────────────
  useNoCopyGuards(true);
  const reportEvent = (type: string, meta?: Record<string, unknown>) => {
    if (sessionIdRef.current) {
      api.post(`/playback/sessions/${sessionIdRef.current}/event`, { type, meta }).catch(() => {});
    }
  };
  useObscureAndDevtools(true, {
    onObscured: () => {
      setObscured(true);
      videoRef.current?.pause();
    },
    onRevealed: () => setObscured(false),
    onDevtools: () => {
      setObscured(true);
      videoRef.current?.pause();
      reportEvent('devtools');
    },
  });

  // ── Start a protected session + attach HLS ───────────────────────────────
  useEffect(() => {
    if (!lessonId) return;
    let cancelled = false;
    setTicket(null);
    setError('');

    (async () => {
      try {
        const { data } = await api.post<PlaybackTicket>('/playback/sessions', { lessonId });
        if (cancelled) return;
        sessionIdRef.current = data.playbackSessionId;
        setTicket(data); // HLS is attached by the effect below, once <video> mounts
      } catch (e: any) {
        if (!cancelled) {
          setError(e.response?.data?.message?.toString() ?? t('player.startError'));
        }
      }
    })();

    return () => {
      cancelled = true;
      // End the session when leaving the lesson.
      if (sessionIdRef.current) {
        api.post(`/playback/sessions/${sessionIdRef.current}/end`).catch(() => {});
        sessionIdRef.current = null;
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  // Attach HLS only after the ticket is set AND the <video> element is mounted.
  useEffect(() => {
    if (ticket && videoRef.current && !hlsRef.current) {
      attachHls(`${apiOrigin()}${ticket.masterUrl}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket]);

  function attachHls(masterUrl: string) {
    const video = videoRef.current;
    if (!video) return;
    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      hls.loadSource(masterUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(t('player.streamError'));
      });
      hlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = masterUrl; // Safari native HLS
    } else {
      setError(t('player.unsupported'));
    }
  }

  // ── Telemetry: heartbeats + play/pause/seek events ───────────────────────
  function heartbeat(type: string) {
    const v = videoRef.current;
    const sid = sessionIdRef.current;
    if (!v || !sid) return;
    const now = Date.now();
    if (type === 'hb' && now - lastHeartbeat.current < 9000) return;
    lastHeartbeat.current = now;
    const watchedPct = v.duration ? (v.currentTime / v.duration) * 100 : 0;
    api
      .post(`/playback/sessions/${sid}/heartbeat`, {
        positionSec: Math.floor(v.currentTime),
        type,
        watchedPct: Math.round(watchedPct),
      })
      .catch(() => {});
  }

  function seekTo(sec: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  }

  if (isLoading) return <Spinner />;

  return (
    <div className="mx-auto max-w-container px-6 py-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <Link to={`/course/${courseId}`} className="mb-1 flex items-center gap-1 text-sm text-primary hover:underline">
            <span className="material-symbols-outlined text-base rtl:rotate-180">arrow_back</span>
            {course?.title}
          </Link>
          <h1 className="font-heading text-2xl font-extrabold">{current?.title}</h1>
        </div>
        <Badge tone="teal">
          <span className="material-symbols-outlined text-sm">lock</span>
          {t('player.protected')}
        </Badge>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row-reverse">
        {/* Curriculum sidebar (inline-start in RTL = right) */}
        <aside className="w-full shrink-0 lg:w-80">
          <div className="card p-4">
            <h2 className="mb-3 font-heading text-lg font-bold">{t('player.courseContent')}</h2>
            <div className="space-y-4">
              {course?.units.map((u: any, ui: number) => (
                <div key={u.id}>
                  <p className="mb-2 text-xs font-bold text-outline">
                    {t('teacher.builder.unitBadge', { n: ui + 1 })} · {u.title}
                  </p>
                  <ul className="space-y-1">
                    {u.lessons.map((l: any) => {
                      const active = l.id === lessonId;
                      return (
                        <li key={l.id}>
                          <button
                            disabled={l.locked}
                            onClick={() => navigate(`/learn/${courseId}/${l.id}`)}
                            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition ${
                              active
                                ? 'bg-primary-fixed font-bold text-primary'
                                : l.locked
                                  ? 'cursor-not-allowed text-outline'
                                  : 'text-on-surface-variant hover:bg-surface-container-low'
                            }`}
                          >
                            <span className="material-symbols-outlined text-lg">
                              {l.locked ? 'lock' : active ? 'play_circle' : 'play_arrow'}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{l.title}</span>
                            {l.durationSec > 0 && (
                              <span className="text-xs text-outline">{duration(l.durationSec)}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Player + panels */}
        <div className="min-w-0 flex-1">
          <div className="relative aspect-video overflow-hidden rounded-xl bg-black shadow-modal">
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/80">
                <span className="material-symbols-outlined text-5xl text-error">error</span>
                <p className="px-6">{error}</p>
              </div>
            ) : !ticket ? (
              <div className="flex h-full items-center justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  className="h-full w-full"
                  controls
                  controlsList="nodownload noplaybackrate noremoteplayback"
                  disablePictureInPicture
                  onContextMenu={(e) => e.preventDefault()}
                  onPlay={() => heartbeat('play')}
                  onPause={() => heartbeat('pause')}
                  onSeeked={() => heartbeat('seek')}
                  onTimeUpdate={() => heartbeat('hb')}
                />
                <RovingWatermark payload={ticket.watermark} />
                {/* Pause + blur overlay on tab blur / devtools */}
                {obscured && (
                  <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/90 backdrop-blur-xl">
                    <span className="material-symbols-outlined text-5xl text-accent">visibility_off</span>
                    <p className="px-8 text-center font-heading text-lg font-bold text-white">
                      {t('player.pausedObscured')}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Security note (honest) */}
          <p className="mt-2 flex items-center gap-1 text-xs text-outline">
            <span className="material-symbols-outlined text-sm">shield</span>
            {t('player.watermarkNote')}
          </p>

          {/* Next lesson */}
          {nextLesson && (
            <div className="mt-4 flex justify-end">
              <button className="btn-primary" onClick={() => navigate(`/learn/${courseId}/${nextLesson.id}`)}>
                {t('player.nextLesson')} ←
              </button>
            </div>
          )}

          {/* Tabs */}
          <div className="mt-6 border-b border-outline-variant/50">
            <div className="flex gap-6">
              {(['notes', 'attachments'] as Tab[]).map((tb) => (
                <button
                  key={tb}
                  className={`-mb-px border-b-2 pb-3 font-heading font-bold transition ${
                    tab === tb ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant'
                  }`}
                  onClick={() => setTab(tb)}
                >
                  {tb === 'notes' ? t('player.notesTab') : t('player.attachmentsTab', { count: current?.attachments?.length ?? 0 })}
                </button>
              ))}
            </div>
          </div>

          {tab === 'notes' && (
            <div className="py-5">
              <div className="card mb-4">
                <textarea
                  className="input min-h-20"
                  placeholder={t('player.notePlaceholder')}
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                />
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-sm text-primary" dir="ltr">
                    ⏱ {formatClock(Math.floor(videoRef.current?.currentTime ?? 0))}
                  </span>
                  <button
                    className="btn-primary px-5 py-2 text-sm"
                    disabled={!noteBody.trim() || addNote.isPending}
                    onClick={() => addNote.mutate()}
                  >
                    {t('player.saveNote')}
                  </button>
                </div>
              </div>
              <ul className="space-y-2">
                {(notes ?? []).map((n: any) => (
                  <li key={n.id} className="card flex items-start gap-3 py-3">
                    <button
                      className="rounded-md bg-primary-fixed px-2 py-1 font-mono text-xs font-bold text-primary"
                      dir="ltr"
                      onClick={() => seekTo(n.timestampSec)}
                    >
                      {formatClock(n.timestampSec)}
                    </button>
                    <p className="min-w-0 flex-1 text-sm">{n.body}</p>
                    <button className="text-outline hover:text-error" onClick={() => delNote.mutate(n.id)}>
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </li>
                ))}
                {!notes?.length && <p className="py-4 text-center text-sm text-outline">{t('player.noNotes')}</p>}
              </ul>
            </div>
          )}

          {tab === 'attachments' && (
            <div className="py-5">
              {current?.attachments?.length ? (
                <ul className="space-y-2">
                  {current.attachments.map((a: any) => (
                    <li key={a.id} className="card flex items-center justify-between py-3">
                      <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-error">description</span>
                        <span dir="auto">{a.fileName}</span>
                      </span>
                      <a
                        href={`${apiOrigin()}/api/v1/files/attachments/${a.id}`}
                        className="btn-ghost px-4 py-1.5 text-sm"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('player.download')}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-outline">{t('player.noAttachments')}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

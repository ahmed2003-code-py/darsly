import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PlaybackTicket, Role } from '@darsly/shared-types';
import RovingWatermark from '../../components/RovingWatermark';
import { Badge, Spinner } from '../../components/ui';
import { api, apiOrigin } from '../../lib/api';
import { duration } from '../../lib/format';
import { useObscureAndDevtools, useNoCopyGuards } from '../../lib/player-hardening';
import { useAuthStore } from '../../stores/auth';

type Tab = 'notes' | 'attachments' | 'qa';

export default function SecureVideoPlayerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastHeartbeat = useRef(0);

  const [ticket, setTicket] = useState<PlaybackTicket | null>(null);
  const [error, setError] = useState('');
  const [obscured, setObscured] = useState(false);
  const [tab, setTab] = useState<Tab>('notes');
  const [noteBody, setNoteBody] = useState('');

  // ── Advanced player controls ──────────────────────────────────────────────
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem('darsly-rate')) || 1);
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([]);
  const [quality, setQuality] = useState<number>(-1); // -1 = auto
  const [menu, setMenu] = useState<'speed' | 'quality' | 'keys' | null>(null);
  const [resumedAt, setResumedAt] = useState<number>(0);

  function applyRate(r: number) {
    setRate(r);
    localStorage.setItem('darsly-rate', String(r));
    if (videoRef.current) videoRef.current.playbackRate = r;
    setMenu(null);
  }
  function applyQuality(level: number) {
    setQuality(level);
    if (hlsRef.current) hlsRef.current.currentLevel = level;
    setMenu(null);
  }

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

  // Keyboard shortcuts (ignored while typing in the notes box / inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const v = videoRef.current;
      if (!v) return;
      const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          v.paused ? v.play().catch(() => {}) : v.pause();
          break;
        case 'ArrowRight': e.preventDefault(); v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); break;
        case 'ArrowLeft': e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); break;
        case 'ArrowUp': e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
        case 'ArrowDown': e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
        case 'm': v.muted = !v.muted; break;
        case 'f': if (v.requestFullscreen) v.requestFullscreen().catch(() => {}); break;
        case '>': case '.': { const i = rates.indexOf(v.playbackRate); applyRate(rates[Math.min(rates.length - 1, i + 1)] ?? v.playbackRate); break; }
        case '<': case ',': { const i = rates.indexOf(v.playbackRate); applyRate(rates[Math.max(0, i - 1)] ?? v.playbackRate); break; }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Expose the rendition ladder for the quality menu (highest first).
        const ls = [...hls.levels]
          .map((l) => ({ height: l.height, bitrate: l.bitrate }))
          .sort((a, b) => b.height - a.height);
        setLevels(ls);
      });
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

  /** Start (or continue) a Q&A thread with the teacher, pinned to this moment. */
  async function askTeacher() {
    const q = window.prompt(t('player.askPrompt'));
    if (!q?.trim() || !course?.teacher?.id) return;
    const { data } = await api.post('/chat/messages', {
      tenantId: course.teacher.id,
      lessonId,
      videoTimestampSec: Math.floor(videoRef.current?.currentTime ?? 0),
      body: q.trim(),
    });
    navigate(`/messages?t=${data.threadId}`);
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
        <div className="flex items-center gap-2">
          {user?.role === Role.STUDENT && course?.teacher && (
            <button className="btn-ghost px-4 py-2 text-sm" onClick={askTeacher}>
              <span className="material-symbols-outlined text-base">live_help</span>
              {t('player.askTeacher')}
            </button>
          )}
          <Badge tone="teal">
            <span className="material-symbols-outlined text-sm">lock</span>
            {t('player.protected')}
          </Badge>
        </div>
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
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    v.playbackRate = rate;
                    const r = ticket?.resumeAtSec ?? 0;
                    if (r > 5 && v.duration && r < v.duration - 5) {
                      v.currentTime = r;
                      setResumedAt(r);
                      window.setTimeout(() => setResumedAt(0), 6000);
                    }
                  }}
                  onPlay={() => heartbeat('play')}
                  onPause={() => heartbeat('pause')}
                  onSeeked={() => heartbeat('seek')}
                  onTimeUpdate={() => heartbeat('hb')}
                />
                <RovingWatermark payload={ticket.watermark} />

                {/* Resume toast */}
                {resumedAt > 0 && (
                  <div className="absolute bottom-16 start-4 z-20 flex items-center gap-2 rounded-xl bg-black/80 px-3 py-2 text-sm text-white backdrop-blur">
                    <span className="material-symbols-outlined text-base text-accent">history</span>
                    {t('player.resumedFrom', { time: formatClock(resumedAt) })}
                  </div>
                )}

                {/* Advanced controls toolbar (speed / quality / shortcuts) */}
                <div className="absolute end-3 top-3 z-20 flex items-center gap-2" dir="ltr">
                  <PlayerMenu
                    icon="speed"
                    label={`${rate}×`}
                    open={menu === 'speed'}
                    onToggle={() => setMenu(menu === 'speed' ? null : 'speed')}
                    items={RATES.map((r) => ({ key: String(r), label: r === 1 ? t('player.normal') : `${r}×`, active: r === rate, onClick: () => applyRate(r) }))}
                  />
                  {levels.length > 1 && (
                    <PlayerMenu
                      icon="hd"
                      label={quality === -1 ? t('player.auto') : `${levels.find((_, i) => i === quality)?.height ?? ''}p`}
                      open={menu === 'quality'}
                      onToggle={() => setMenu(menu === 'quality' ? null : 'quality')}
                      items={[
                        { key: 'auto', label: t('player.auto'), active: quality === -1, onClick: () => applyQuality(-1) },
                        ...levels.map((l, i) => ({ key: String(i), label: `${l.height}p`, active: quality === i, onClick: () => applyQuality(i) })),
                      ]}
                    />
                  )}
                  <button
                    className="grid h-9 w-9 place-items-center rounded-lg bg-black/50 text-white/90 backdrop-blur transition hover:bg-black/70"
                    title={t('player.shortcuts')}
                    onClick={() => setMenu(menu === 'keys' ? null : 'keys')}
                  >
                    <span className="material-symbols-outlined text-lg">keyboard</span>
                  </button>
                  {menu === 'keys' && (
                    <div className="absolute end-0 top-11 w-56 rounded-xl bg-black/85 p-3 text-xs text-white/90 backdrop-blur">
                      <p className="mb-2 font-bold text-white">{t('player.shortcuts')}</p>
                      <ul className="space-y-1">
                        {[
                          ['Space / K', t('player.kPlay')],
                          ['← / →', t('player.kSeek')],
                          ['↑ / ↓', t('player.kVolume')],
                          ['M', t('player.kMute')],
                          ['F', t('player.kFullscreen')],
                          ['< / >', t('player.kSpeed')],
                        ].map(([k, d]) => (
                          <li key={k} className="flex items-center justify-between gap-3">
                            <span className="text-white/70">{d}</span>
                            <kbd className="rounded bg-white/15 px-1.5 py-0.5 font-mono">{k}</kbd>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
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

/** A compact overlay menu button (speed / quality) for the hardened player. */
function PlayerMenu({
  icon, label, open, onToggle, items,
}: {
  icon: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  items: { key: string; label: string; active: boolean; onClick: () => void }[];
}) {
  return (
    <div className="relative">
      <button
        className="flex h-9 items-center gap-1 rounded-lg bg-black/50 px-2.5 text-sm font-bold text-white/90 backdrop-blur transition hover:bg-black/70"
        onClick={onToggle}
      >
        <span className="material-symbols-outlined text-lg">{icon}</span>
        {label}
      </button>
      {open && (
        <div className="absolute end-0 top-11 min-w-[7rem] overflow-hidden rounded-xl bg-black/85 py-1 text-sm text-white/90 backdrop-blur">
          {items.map((it) => (
            <button
              key={it.key}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-start transition hover:bg-white/10 ${it.active ? 'text-accent' : ''}`}
              onClick={it.onClick}
            >
              {it.label}
              {it.active && <span className="material-symbols-outlined text-base">check</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
import { GAMIFICATION_KEY, GamificationOutcome } from '../../lib/gamification';
import { Markdown } from '../../lib/markdown';
import { RewardBurst } from '../../components/gamification/RewardBurst';

type Tab = 'notes' | 'attachments' | 'qa';

export default function SecureVideoPlayerPage() {
  const { t } = useTranslation();
  const { courseId, lessonId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [reward, setReward] = useState<GamificationOutcome | null>(null);
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

  /**
   * Fullscreen the frame, never the bare <video>.
   *
   * The browser's own fullscreen button promotes the video element alone, and
   * everything we draw on top of it — the speed and quality menus, and the
   * watermark carrying the viewer's identity — is outside that element. Asking
   * the browser to swap that button's target after the fact (exit the video's
   * fullscreen, then request it on the frame instead) used to be the whole
   * fix — but that hop crosses a promise boundary, and by the time it resolves
   * some browsers no longer treat the click as a real user gesture and silently
   * refuse the second request, leaving the student with no fullscreen at all.
   * So the native button is hidden below (`nofullscreen` in controlsList) and
   * this toggle — reachable only from a direct click or the `f` shortcut, both
   * genuine gestures — is the one path in. The listener stays only for
   * browsers that ignore controlsList (Firefox, Safari) and still show it.
   */
  const frameRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frame.requestFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const onChange = () => {
      const el = document.fullscreenElement;
      setIsFullscreen(!!el);
      if (el && el === videoRef.current && frameRef.current) {
        document.exitFullscreen().then(() => frameRef.current?.requestFullscreen?.()).catch(() => {});
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ── Advanced player controls ──────────────────────────────────────────────
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem('darsly-rate')) || 1);
  // `index` is the position in hls.levels, kept because the menu lists them
  // best-first while hls.js orders them worst-first — handing it a display
  // position as a level index picks the opposite quality to the one tapped.
  const [levels, setLevels] = useState<{ index: number; height: number; label: string }[]>([]);
  const [quality, setQuality] = useState<number>(-1); // -1 = auto
  const [menu, setMenu] = useState<'speed' | 'quality' | 'keys' | null>(null);
  const [resumedAt, setResumedAt] = useState<number>(0);

  // ── Custom control bar state (the player has no native controls at all —
  // one bar, one set of buttons, nothing the browser draws on top of it) ────
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [muted, setMuted] = useState(false);

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

  // A course can be nothing but a flat list of lessons — the sidebar numbers
  // only the named sections, and the unnamed one just isn't labelled.
  let sectionNumber = 0;
  const sidebarUnits: { unit: any; sectionN: number | null }[] =
    course?.units.map((u: any) => ({ unit: u, sectionN: u.isDefault ? null : ++sectionNumber })) ?? [];

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

  /**
   * Did the student ask for this seek?
   *
   * The browser fires `seeked` for far more than a drag of the bar: hls.js
   * nudges past buffer holes, recovers from stalls, and jumps to the resume
   * position on load. Reporting all of those as seeks is what made a student on
   * a weak connection look like a scraper to the anomaly detector. Set right
   * before every seek the player performs on the student's behalf, and read
   * once by the `seeked` handler.
   */
  const userSeek = useRef(false);

  /**
   * What just happened, shown for a moment.
   *
   * A shortcut with no acknowledgement is indistinguishable from a shortcut
   * that did not fire, which is most of why these felt broken: pressing the
   * right arrow moved the picture ten seconds on and said nothing, so the only
   * way to know it worked was to already know where you were.
   */
  const [flash, setFlash] = useState<{ icon: string; label: string; side: 'start' | 'end' | 'center' } | null>(null);
  const flashTimer = useRef<number | null>(null);
  const say = (icon: string, label: string, side: 'start' | 'end' | 'center' = 'center') => {
    setFlash({ icon, label, side });
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 700);
  };

  // Keyboard shortcuts (ignored while typing in the notes box / inputs).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const v = videoRef.current;
      if (!v) return;
      const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
      // The letters come from `e.code`, which is the key's place on the board
      // rather than the character it produces. On an Arabic layout `e.key` for
      // the K key is "ن", so every letter shortcut silently did nothing — and a
      // capital M did nothing either, because "M" is not "m".
      const code = e.code;
      const pct = (n: number) => `${Math.round(n * 100)}%`;
      switch (true) {
        case e.key === ' ' || code === 'Space' || code === 'KeyK':
          e.preventDefault();
          if (v.paused) { v.play().catch(() => {}); say('play_arrow', t('player.kPlay')); }
          else { v.pause(); say('pause', t('player.kPlay')); }
          break;
        case e.key === 'ArrowRight':
          e.preventDefault(); userSeek.current = true;
          v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10);
          say('forward_10', '+10', 'end');
          break;
        case e.key === 'ArrowLeft':
          e.preventDefault(); userSeek.current = true;
          v.currentTime = Math.max(0, v.currentTime - 10);
          say('replay_10', '−10', 'start');
          break;
        case e.key === 'ArrowUp':
          e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); v.muted = false;
          say('volume_up', pct(v.volume));
          break;
        case e.key === 'ArrowDown':
          e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1);
          say(v.volume === 0 ? 'volume_off' : 'volume_down', pct(v.volume));
          break;
        case code === 'KeyM':
          v.muted = !v.muted;
          say(v.muted ? 'volume_off' : 'volume_up', t('player.kMute'));
          break;
        case code === 'KeyF':
          toggleFullscreen();
          say('fullscreen', t('player.kFullscreen'));
          break;
        case e.key === '>' || e.key === '.' || code === 'Period': {
          const i = rates.indexOf(v.playbackRate);
          const r = rates[Math.min(rates.length - 1, i + 1)] ?? v.playbackRate;
          applyRate(r); say('speed', `${r}×`);
          break;
        }
        case e.key === '<' || e.key === ',' || code === 'Comma': {
          const i = rates.indexOf(v.playbackRate);
          const r = rates[Math.max(0, i - 1)] ?? v.playbackRate;
          applyRate(r); say('slow_motion_video', `${r}×`);
          break;
        }
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
        // A rendition whose master-playlist entry had an unparseable
        // RESOLUTION arrives with height 0 — every video encoded before that
        // was fixed server-side, which would otherwise list as "0p". Its own
        // playlist still lives under a "<height>p/" folder, so the URL names
        // the size the manifest failed to.
        const ls = hls.levels
          .map((l, index) => {
            const fromUrl = String((l as { uri?: string }).uri ?? l.url?.[0] ?? '').match(/\/(\d{3,4})p\//);
            const height = l.height || Number(fromUrl?.[1]) || 0;
            return {
              index,
              height,
              label: height ? `${height}p` : `${Math.round(l.bitrate / 1000)}k`,
            };
          })
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
      // The heartbeat that crosses the completion threshold comes back with
      // what it earned, so finishing a lesson is celebrated in the same round
      // trip instead of after a refetch.
      .then((res) => {
        if (res.data?.gamification?.awarded) {
          setReward(res.data.gamification);
          queryClient.invalidateQueries({ queryKey: GAMIFICATION_KEY });
          queryClient.invalidateQueries({ queryKey: ['progress-summary'] });
        }
      })
      .catch(() => {});
  }

  function seekTo(sec: number) {
    if (videoRef.current) {
      userSeek.current = true;
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  }

  /** Dragging the scrubber moves the position without forcing playback to start. */
  function scrub(sec: number) {
    if (videoRef.current) {
      userSeek.current = true;
      videoRef.current.currentTime = sec;
    }
  }
  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }
  function toggleMute() {
    if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
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
            <span className="material-symbols-outlined text-base rtl:-scale-x-100">arrow_back</span>
            {course?.title}
          </Link>
          <h1 className="font-heading text-2xl font-extrabold">{current?.title}</h1>
          {current?.description && (
            <Markdown className="mt-1 max-w-2xl text-sm text-on-surface-variant">{current.description}</Markdown>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Hidden rather than shown and refused: a teacher who has closed
              messaging is not someone this button can reach. */}
          {user?.role === Role.STUDENT &&
            course?.teacher &&
            course.teacher.acceptsStudentMessages !== false && (
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
              {sidebarUnits.map(({ unit: u, sectionN }) => (
                <div key={u.id}>
                  {sectionN != null && (
                    <p className="mb-2 text-xs font-bold text-outline">
                      {t('teacher.builder.unitBadge', { n: sectionN })} · {u.title}
                    </p>
                  )}
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
                                ? 'bg-primary-fixed font-bold text-on-primary-fixed'
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
          <div
            ref={frameRef}
            // Everything that must stay with the picture lives inside this frame:
            // the video, the overlay controls and the watermark.
            className="player-frame relative aspect-video overflow-hidden rounded-xl bg-black shadow-modal"
            onContextMenu={(e) => e.preventDefault()}
          >
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
                  // No native controls at all — a native bar plus this overlay
                  // used to mean two of everything (two speed menus, a native
                  // fullscreen button that promoted the bare <video> and dropped
                  // the overlay + watermark with it). One custom bar below owns
                  // every control now, so there is exactly one of each.
                  disablePictureInPicture
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={togglePlay}
                  onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
                  onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
                  onDurationChange={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    v.playbackRate = rate;
                    setVideoDuration(v.duration || 0);
                    const r = ticket?.resumeAtSec ?? 0;
                    if (r > 5 && v.duration && r < v.duration - 5) {
                      v.currentTime = r;
                      setResumedAt(r);
                      window.setTimeout(() => setResumedAt(0), 6000);
                    }
                  }}
                  onPlay={() => { setIsPlaying(true); heartbeat('play'); }}
                  // The browser does not fire `pause` when playback ends on its
                  // own, so without this the final seconds of every lesson were
                  // never reported and the lesson never completed.
                  onEnded={() => { setIsPlaying(false); heartbeat('ended'); }}
                  onPause={() => { setIsPlaying(false); heartbeat('pause'); }}
                  onSeeked={() => {
                    const asked = userSeek.current;
                    userSeek.current = false;
                    heartbeat(asked ? 'seek' : 'hb');
                  }}
                  onTimeUpdate={(e) => { setCurrentTime(e.currentTarget.currentTime); heartbeat('hb'); }}
                />
                <RovingWatermark payload={ticket.watermark} />

                {/* What a shortcut just did. Anchored to the side it acted on,
                    so a skip forward reads as forward without being read. */}
                {flash && (
                  <div
                    className={`pointer-events-none absolute inset-y-0 z-20 grid place-items-center ${
                      flash.side === 'center' ? 'inset-x-0' : flash.side === 'end' ? 'end-0 w-1/3' : 'start-0 w-1/3'
                    }`}
                    aria-hidden="true"
                  >
                    <span className="s-pop-in flex flex-col items-center gap-1 rounded-2xl bg-black/60 px-5 py-4 text-white backdrop-blur">
                      <span className="material-symbols-outlined text-4xl leading-none">{flash.icon}</span>
                      <span className="font-heading text-sm font-bold tabular-nums">{flash.label}</span>
                    </span>
                  </div>
                )}

                {/* Big center play button — shown whenever paused, doubles as
                    an affordance that the whole frame is clickable. */}
                {!isPlaying && (
                  <button
                    className="absolute inset-0 z-10 grid place-items-center"
                    onClick={togglePlay}
                    aria-label={t('player.kPlay')}
                  >
                    <span className="material-symbols-outlined grid h-16 w-16 place-items-center rounded-full bg-black/55 text-4xl text-white backdrop-blur">
                      play_arrow
                    </span>
                  </button>
                )}

                {/* Resume toast */}
                {resumedAt > 0 && (
                  <div className="absolute bottom-20 start-4 z-20 flex items-center gap-2 rounded-xl bg-black/80 px-3 py-2 text-sm text-white backdrop-blur">
                    <span className="material-symbols-outlined text-base text-accent">history</span>
                    {t('player.resumedFrom', { time: formatClock(resumedAt) })}
                  </div>
                )}

                {/* One control bar, everything in it — no floating duplicate
                    up top and no native bar underneath. */}
                <div
                  className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-2 pt-6"
                  dir="ltr"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="range"
                    className="video-seek mb-1.5 block w-full"
                    min={0}
                    max={videoDuration || 0}
                    step={0.1}
                    value={Math.min(currentTime, videoDuration || currentTime)}
                    onChange={(e) => scrub(Number(e.target.value))}
                    style={{ '--seek-pct': `${videoDuration ? (currentTime / videoDuration) * 100 : 0}%` } as React.CSSProperties}
                    aria-label={t('player.kSeek')}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/90 transition hover:bg-white/10"
                      onClick={togglePlay}
                    >
                      <span className="material-symbols-outlined text-2xl">{isPlaying ? 'pause' : 'play_arrow'}</span>
                    </button>
                    <button
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/90 transition hover:bg-white/10"
                      onClick={toggleMute}
                    >
                      <span className="material-symbols-outlined text-xl">{muted ? 'volume_off' : 'volume_up'}</span>
                    </button>
                    <span className="shrink-0 font-mono text-xs text-white/80">
                      {formatClock(Math.floor(currentTime))} / {formatClock(Math.floor(videoDuration))}
                    </span>
                    <div className="flex-1" />
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
                        label={quality === -1 ? t('player.auto') : (levels.find((l) => l.index === quality)?.label ?? '')}
                        open={menu === 'quality'}
                        onToggle={() => setMenu(menu === 'quality' ? null : 'quality')}
                        items={[
                          { key: 'auto', label: t('player.auto'), active: quality === -1, onClick: () => applyQuality(-1) },
                          ...levels.map((l) => ({ key: String(l.index), label: l.label, active: quality === l.index, onClick: () => applyQuality(l.index) })),
                        ]}
                      />
                    )}
                    <button
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/90 transition hover:bg-white/10"
                      title={t('player.fullscreen')}
                      onClick={toggleFullscreen}
                    >
                      <span className="material-symbols-outlined text-lg">{isFullscreen ? 'fullscreen_exit' : 'fullscreen'}</span>
                    </button>
                    <div className="relative shrink-0">
                      <button
                        className="grid h-9 w-9 place-items-center rounded-lg text-white/90 transition hover:bg-white/10"
                        title={t('player.shortcuts')}
                        onClick={() => setMenu(menu === 'keys' ? null : 'keys')}
                      >
                        <span className="material-symbols-outlined text-lg">keyboard</span>
                      </button>
                      {menu === 'keys' && (
                        <div className="absolute bottom-11 end-0 w-56 rounded-xl bg-black/85 p-3 text-xs text-white/90 backdrop-blur">
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
                  </div>
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

          {/* What finishing this lesson earned — floats, never blocks. */}
          <RewardBurst outcome={reward} onDone={() => setReward(null)} />

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
                      className="rounded-md bg-primary-fixed px-2 py-1 font-mono text-xs font-bold text-on-primary-fixed"
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
    <div className="relative shrink-0">
      <button
        className="flex h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-bold text-white/90 transition hover:bg-white/10"
        onClick={onToggle}
      >
        <span className="material-symbols-outlined text-lg">{icon}</span>
        {label}
      </button>
      {open && (
        <div className="absolute bottom-11 end-0 min-w-[7rem] overflow-hidden rounded-xl bg-black/85 py-1 text-sm text-white/90 backdrop-blur">
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

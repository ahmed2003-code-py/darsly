import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import type { Participant } from './useDailyMeeting';
import { initialLayer, nextLayer, type LayerState } from './simulcast';
import { audioConstraint, videoConstraint } from './liveDevices';
import { LessonAudio } from './lessonAudio';
import { idbPieceStore } from './lessonAudioStore';

/**
 * The Darsly classroom over Cloudflare Realtime.
 *
 * Cloudflare's SFU carries media and nothing else: no rooms, no participant
 * list, no permissions. Those are Darsly's, and they come from the server —
 * `GET /live/:id/rtc/state` says who is here, what is published and who may
 * speak, and every push and pull goes through Darsly's RTC endpoints, which
 * check it before the SFU is asked. The browser never holds a provider secret.
 *
 * Two connections, never one:
 *  - RECEIVE: everyone has one; it pulls the teacher (camera, voice, screen)
 *    and whichever students are allowed to speak.
 *  - SEND: the teacher always; a student only while the teacher lets them
 *    speak. Separate, so granting or revoking a voice never renegotiates what
 *    a student is watching — and a revoke is enforced at the SFU regardless.
 *
 * Returns the same shape as useDailyMeeting, plus the raise-hand flow, so the
 * classroom page does not care which provider carries the class.
 */

const HEARTBEAT_MS = 30_000;
/** A safety net under the socket: state is re-read at least this often. */
const STATE_POLL_MS = 20_000;
/** How long a connection may sit disconnected before it is rebuilt. */
const RECONNECT_AFTER_MS = 4_000;

type Kind = 'AUDIO' | 'VIDEO' | 'SCREEN' | 'SCREEN_AUDIO';
export type HandState =
  'IDLE' | 'HAND_RAISED' | 'APPROVED_TO_SPEAK' | 'ACTIVE_SPEAKER' | 'RELEASED';

export interface RtcState {
  sessionId: string;
  run: string;
  serverNow: string;
  me: { userId: string; role: 'TEACHER' | 'STUDENT'; hand: HandState; canPublish: boolean };
  maxSpeakers: number;
  recording?: boolean;
  /** The lesson's words are being captured right now (OFF / MANUAL / AUTO, decided by the server). */
  transcribing?: boolean;
  /** The teacher's view: the lesson's transcription mode. */
  transcription?: { mode: 'OFF' | 'MANUAL' | 'AUTO_WHEN_RECORDING'; available: boolean };
  participants: {
    userId: string;
    name: string;
    role: 'TEACHER' | 'STUDENT';
    hand: HandState;
    audio: boolean;
    video: boolean;
    screen: boolean;
  }[];
  tracks: { id: string; userId: string; kind: Kind; role: 'TEACHER' | 'STUDENT' }[];
}

export interface CloudflareAccess {
  provider: 'cloudflare';
  iceServers: RTCIceServer[];
  rtcPath: string;
  /** Capture the lesson's audio for its transcript (the teacher, when switched on). */
  transcribe?: boolean;
}

/** Runs async steps one after another: a PeerConnection negotiates one change at a time. */
function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

interface Conn {
  pc: RTCPeerConnection;
  id: string;
  run: (fn: () => Promise<unknown>) => Promise<unknown>;
  closed: boolean;
  downSince: number | null;
}

interface Pulled {
  mid: string;
  kind: Kind;
  userId: string;
  track: MediaStreamTrack | null;
  /** The teacher's camera comes in layers; this is the one being received. */
  layer: LayerState | null;
}

/** How often a student's page looks at what is arriving (see simulcast.ts). */
const LAYER_CHECK_MS = 4_000;

const errCode = (e: any): string | undefined => e?.response?.data?.code;

export function useCloudflareMeeting(
  liveSessionId: string,
  opts: {
    enabled: boolean;
    onTiming?: (timing: { startedAt: string | null; endsAt: string; serverNow: string }) => void;
  },
) {
  const { enabled } = opts;
  const onTimingRef = useRef(opts.onTiming);
  onTimingRef.current = opts.onTiming;
  const base = `/live/${liveSessionId}/rtc`;

  const [state, setState] = useState<RtcState | null>(null);
  const [joined, setJoined] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected');
  /** This page is capturing the lesson's audio for its transcript. */
  const [capturing, setCapturing] = useState(false);
  const lessonAudio = useRef<LessonAudio | null>(null);
  /** The server allows this page to capture (the teacher, transcription on). */
  const [mayCapture, setMayCapture] = useState(false);
  /** Bumped whenever a remote or local track appears or goes, to re-render tiles. */
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const ice = useRef<RTCIceServer[]>([]);
  const recv = useRef<Conn | null>(null);
  const send = useRef<Conn | null>(null);
  const pulled = useRef(new Map<string, Pulled>()); // trackId → pulled
  const byMid = useRef(new Map<string, MediaStreamTrack>()); // recv mid → track
  const local = useRef(new Map<Kind, { track: MediaStreamTrack; mid: string | null }>());
  const audioEls = useRef(new Map<string, HTMLAudioElement>()); // trackId → element
  const stateRef = useRef<RtcState | null>(null);
  const joinedRef = useRef(false);
  const leaving = useRef(false);
  const reconciling = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  // ── Plumbing ──────────────────────────────────────────────────────────────

  const newPc = useCallback(() => {
    return new RTCPeerConnection({ iceServers: ice.current, bundlePolicy: 'max-bundle' });
  }, []);

  const watch = useCallback((c: Conn, onDown: () => void) => {
    c.pc.addEventListener('connectionstatechange', () => {
      const s = c.pc.connectionState;
      if (s === 'connected') c.downSince = null;
      if ((s === 'disconnected' || s === 'failed') && c.downSince == null) c.downSince = Date.now();
      if (s === 'failed') onDown();
    });
  }, []);

  /** Play a remote voice. Autoplay can be refused on phones until a tap. */
  const playAudio = useCallback((trackId: string, track: MediaStreamTrack) => {
    let el = audioEls.current.get(trackId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.style.display = 'none';
      document.body.appendChild(el);
      audioEls.current.set(trackId, el);
    }
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => setAudioBlocked(true));
  }, []);

  const dropAudio = useCallback((trackId: string) => {
    const el = audioEls.current.get(trackId);
    if (!el) return;
    el.srcObject = null;
    el.remove();
    audioEls.current.delete(trackId);
  }, []);

  /** After a tap: everything that was refused, played. */
  const resumeAudio = useCallback(() => {
    setAudioBlocked(false);
    for (const el of audioEls.current.values()) {
      void el.play().catch(() => setAudioBlocked(true));
    }
  }, []);

  const fetchState = useCallback(async (): Promise<RtcState | null> => {
    try {
      const s = (await api.get(`${base}/state`)).data as RtcState;
      stateRef.current = s;
      setState(s);
      return s;
    } catch (e) {
      const code = errCode(e);
      if (code === 'ENDED') setEnded(true);
      return null;
    }
  }, [base]);

  // ── Receiving ─────────────────────────────────────────────────────────────

  const openRecv = useCallback(async () => {
    const { connectionId } = (await api.post(`${base}/connections`, { purpose: 'RECEIVE' })).data;
    const pc = newPc();
    const c: Conn = { pc, id: connectionId, run: queue(), closed: false, downSince: null };
    pc.ontrack = (e) => {
      const mid = e.transceiver?.mid;
      if (mid) byMid.current.set(mid, e.track);
      for (const [trackId, p] of pulled.current) {
        if (p.mid === mid) {
          p.track = e.track;
          if (p.kind === 'AUDIO' || p.kind === 'SCREEN_AUDIO') playAudio(trackId, e.track);
        }
      }
      bump();
    };
    watch(c, () => undefined);
    recv.current = c;
    pulled.current.clear();
    byMid.current.clear();
    return c;
  }, [base, newPc, watch, playAudio, bump]);

  /** Pull what should be pulled, close what should not — from the server's state. */
  const reconcile = useCallback(async () => {
    if (reconciling.current) {
      again.current = true;
      return reconciling.current;
    }
    const work = (async () => {
      do {
        again.current = false;
        const s = stateRef.current;
        if (!s || !joinedRef.current) return;
        const me = s.me.userId;
        const want = new Map(s.tracks.filter((t) => t.userId !== me).map((t) => [t.id, t]));
        const add = [...want.keys()].filter((id) => !pulled.current.has(id));
        const drop = [...pulled.current.keys()].filter((id) => !want.has(id));
        // Opened when there is first something to receive, not at entry:
        // Cloudflare ends an SFU session that sits unconnected, and a teacher
        // waiting for the first student to speak would come back to a dead one.
        let c = recv.current;
        if (!c || c.closed) {
          if (!add.length) return;
          c = await openRecv();
        }
        const conn = c;

        if (drop.length) {
          await conn.run(async () => {
            const mids: string[] = [];
            for (const id of drop) {
              const p = pulled.current.get(id)!;
              pulled.current.delete(id);
              dropAudio(id);
              mids.push(p.mid);
              const tr = conn.pc.getTransceivers().find((x) => x.mid === p.mid);
              try {
                tr?.stop();
              } catch {
                /* already stopped */
              }
            }
            try {
              const offer = await conn.pc.createOffer();
              await conn.pc.setLocalDescription(offer);
              const r = (
                await api.post(`${base}/connections/${conn.id}/close-tracks`, {
                  mids,
                  offer: { type: 'offer', sdp: offer.sdp },
                })
              ).data;
              if (r.sessionDescription) await conn.pc.setRemoteDescription(r.sessionDescription);
            } catch {
              // The publisher is gone already; the SFU has nothing to close.
            }
          });
          bump();
        }

        if (add.length) {
          await conn.run(async () => {
            let r: any;
            try {
              r = (
                await api.post(`${base}/connections/${conn.id}/subscribe`, {
                  trackIds: add,
                  preferredRid: 'h',
                })
              ).data;
            } catch (e) {
              const code = errCode(e);
              if (code === 'RTC_TRACKS_GONE') {
                again.current = true;
                await fetchState();
                return;
              }
              if (code === 'RTC_SESSION_EXPIRED' || code === 'RTC_CONNECTION_GONE') {
                // The connection is no longer usable: drop it; the next pass
                // opens a new one (which also closes the old one server-side)
                // and pulls everything again.
                conn.closed = true;
                try {
                  conn.pc.close();
                } catch {
                  /* closed */
                }
                if (recv.current === conn) recv.current = null;
                for (const id of [...pulled.current.keys()]) dropAudio(id);
                pulled.current.clear();
                byMid.current.clear();
                again.current = true;
                return;
              }
              throw e;
            }
            for (const t of r.tracks as {
              trackId: string;
              mid: string | null;
              error: string | null;
            }[]) {
              const info = want.get(t.trackId);
              if (!t.mid || t.error || !info) continue;
              const p: Pulled = {
                mid: t.mid,
                kind: info.kind,
                userId: info.userId,
                track: null,
                layer:
                  info.kind === 'VIDEO' && info.role === 'TEACHER'
                    ? initialLayer(Date.now())
                    : null,
              };
              pulled.current.set(t.trackId, p);
            }
            if (r.requiresImmediateRenegotiation && r.sessionDescription) {
              await conn.pc.setRemoteDescription(r.sessionDescription);
              const answer = await conn.pc.createAnswer();
              await conn.pc.setLocalDescription(answer);
              await api.put(`${base}/connections/${conn.id}/renegotiate`, {
                answer: { type: 'answer', sdp: answer.sdp },
              });
            }
            // Tracks whose ontrack fired before we knew their id.
            for (const [trackId, p] of pulled.current) {
              if (!p.track && byMid.current.has(p.mid)) {
                p.track = byMid.current.get(p.mid)!;
                if (p.kind === 'AUDIO' || p.kind === 'SCREEN_AUDIO') playAudio(trackId, p.track);
              }
            }
          });
          bump();
        }
      } while (again.current);
    })().finally(() => {
      reconciling.current = null;
    });
    reconciling.current = work;
    return work;
  }, [base, dropAudio, playAudio, fetchState, bump]);

  // ── Sending ───────────────────────────────────────────────────────────────

  const openSend = useCallback(async () => {
    const { connectionId } = (await api.post(`${base}/connections`, { purpose: 'SEND' })).data;
    const c: Conn = { pc: newPc(), id: connectionId, run: queue(), closed: false, downSince: null };
    watch(c, () => undefined);
    send.current = c;
    return c;
  }, [base, newPc, watch]);

  const closeConn = useCallback(
    async (ref: React.MutableRefObject<Conn | null>) => {
      const c = ref.current;
      ref.current = null;
      if (!c) return;
      c.closed = true;
      try {
        c.pc.close();
      } catch {
        /* closed */
      }
      await api.delete(`${base}/connections/${c.id}`).catch(() => undefined);
    },
    [base],
  );

  /** Send one kind of track (a new one replaces the last of that kind). */
  /** One push on a sending connection. */
  const pushOn = useCallback(
    async (c: Conn, kind: Kind, track: MediaStreamTrack) => {
      await c.run(async () => {
        // The teacher's camera goes out in two layers (simulcast): 720p and a
        // quarter of it. Each student receives the one their link can carry.
        const encodings: RTCRtpEncodingParameters[] | undefined =
          kind === 'VIDEO'
            ? stateRef.current?.me.role === 'TEACHER'
              ? [
                  { rid: 'h', maxBitrate: 1_200_000 },
                  { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
                ]
              : [{ maxBitrate: 350_000 }]
            : kind === 'SCREEN'
              ? [{ maxBitrate: 1_000_000, maxFramerate: 8 }]
              : undefined;
        if (kind === 'SCREEN') track.contentHint = 'detail';
        const tr = c.pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: encodings });
        const offer = await c.pc.createOffer();
        await c.pc.setLocalDescription(offer);
        const r = (
          await api.post(`${base}/connections/${c.id}/publish`, {
            offer: { type: 'offer', sdp: offer.sdp },
            tracks: [{ mid: tr.mid, kind }],
          })
        ).data;
        await c.pc.setRemoteDescription(r.sessionDescription);
        const prev = local.current.get(kind);
        if (prev && prev.track !== track) prev.track.stop();
        local.current.set(kind, { track, mid: tr.mid });
      });
    },
    [base],
  );

  /**
   * Send one kind of track (a new one replaces the last of that kind). If the
   * sending connection has expired at the SFU, a new one is opened and
   * everything this browser was sending goes out on it again.
   */
  const publish = useCallback(
    async (kind: Kind, track: MediaStreamTrack) => {
      const c = send.current ?? (await openSend());
      try {
        await pushOn(c, kind, track);
      } catch (e) {
        const code = errCode(e);
        if (code !== 'RTC_SESSION_EXPIRED' && code !== 'RTC_CONNECTION_GONE') throw e;
        const others = [...local.current.entries()].filter(([k]) => k !== kind);
        c.closed = true;
        try {
          c.pc.close();
        } catch {
          /* closed */
        }
        if (send.current === c) send.current = null;
        local.current.clear();
        const fresh = await openSend();
        for (const [k, l] of others) {
          if (l.track.readyState === 'live') await pushOn(fresh, k, l.track);
        }
        await pushOn(fresh, kind, track);
      }
      bump();
    },
    [openSend, pushOn, bump],
  );

  /** Stop sending one kind: the device is released, the SFU is told. */
  const unpublish = useCallback(
    async (kind: Kind) => {
      const l = local.current.get(kind);
      local.current.delete(kind);
      l?.track.stop();
      bump();
      const c = send.current;
      if (!c || !l?.mid) return;
      await c.run(async () => {
        const tr = c.pc.getTransceivers().find((x) => x.mid === l.mid);
        try {
          tr?.stop();
        } catch {
          /* stopped */
        }
        try {
          const offer = await c.pc.createOffer();
          await c.pc.setLocalDescription(offer);
          const r = (
            await api.post(`${base}/connections/${c.id}/close-tracks`, {
              mids: [l.mid],
              offer: { type: 'offer', sdp: offer.sdp },
            })
          ).data;
          if (r.sessionDescription) await c.pc.setRemoteDescription(r.sessionDescription);
        } catch {
          // Revoked or ended: the server already closed it.
        }
      });
    },
    [base, bump],
  );

  /** Everything this browser sends, stopped (revoked, left, or ended). */
  const stopSending = useCallback(async () => {
    for (const [, l] of local.current) l.track.stop();
    local.current.clear();
    setMicOn(false);
    setCamOn(false);
    setSharing(false);
    await closeConn(send);
    bump();
  }, [closeConn, bump]);

  const getMic = () =>
    navigator.mediaDevices
      .getUserMedia({ audio: audioConstraint({ echoCancellation: true, noiseSuppression: true }) })
      .then((s) => s.getAudioTracks()[0]);
  const getCam = (teacher: boolean) =>
    navigator.mediaDevices
      .getUserMedia({
        // The camera chosen in the lobby, when there is one.
        video: videoConstraint(
          teacher
            ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }
            : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
        ),
      })
      .then((s) => s.getVideoTracks()[0]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Camera preview before entering — the teacher's; a student sends nothing by default. */
  const [preview, setPreview] = useState<MediaStreamTrack | null>(null);
  const previewRef = useRef<MediaStreamTrack | null>(null);
  const startPreview = useCallback(async () => {
    try {
      const t = await getCam(true);
      previewRef.current?.stop();
      previewRef.current = t;
      setPreview(t);
      setCamOn(true);
    } catch {
      setCamOn(false);
    }
  }, []);

  const join = useCallback(
    async (access: CloudflareAccess, o: { mic: boolean; cam: boolean; owner?: boolean }) => {
      setError(null);
      leaving.current = false;
      ice.current = access.iceServers ?? [];
      try {
        joinedRef.current = true;
        setJoined(true);
        const s = await fetchState();
        await reconcile();
        if (s?.me.role === 'TEACHER' || o.owner) {
          const cam = o.cam ? (previewRef.current ?? (await getCam(true).catch(() => null))) : null;
          previewRef.current = null;
          setPreview(null);
          if (!o.cam) cam?.stop();
          if (cam) {
            await publish('VIDEO', cam);
            setCamOn(true);
          }
          if (o.mic) {
            const mic = await getMic().catch(() => null);
            if (mic) {
              await publish('AUDIO', mic);
              setMicOn(true);
            } else setNotice('MIC_FAILED');
          }
          // Capturing the lesson's words follows the server's answer (below):
          // this only says this page is the one allowed to do it.
          setMayCapture(!!access.transcribe);
        } else {
          // Education mode: a student enters listening. Nothing was asked of
          // their camera or microphone, and nothing is sent.
          previewRef.current?.stop();
          previewRef.current = null;
          setPreview(null);
          setCamOn(false);
          setMicOn(false);
        }
      } catch (e) {
        const code = errCode(e);
        if (code === 'ENDED') setEnded(true);
        setError(code ?? 'meeting');
      }
    },
    [openRecv, fetchState, reconcile, publish],
  );

  /** The last piece of the lesson's audio is sent; capture stops. */
  const stopCapture = useCallback(() => {
    const la = lessonAudio.current;
    lessonAudio.current = null;
    setCapturing(false);
    // Not awaited: the upload finishes in the background while the page moves on.
    if (la) void la.stop();
  }, []);

  const teardown = useCallback(async () => {
    joinedRef.current = false;
    stopCapture();
    for (const [, l] of local.current) l.track.stop();
    local.current.clear();
    previewRef.current?.stop();
    previewRef.current = null;
    for (const id of [...audioEls.current.keys()]) dropAudio(id);
    pulled.current.clear();
    await Promise.all([closeConn(send), closeConn(recv)]);
    setJoined(false);
  }, [closeConn, dropAudio, stopCapture]);

  const leave = useCallback(async () => {
    leaving.current = true;
    await teardown();
    await api.post(`/live/${liveSessionId}/leave`).catch(() => undefined);
  }, [teardown, liveSessionId]);

  /** Rebuild a dropped connection: a new SFU session, everything pulled or sent again. */
  const reconnect = useCallback(async () => {
    if (!joinedRef.current || leaving.current) return;
    const r = recv.current;
    if (r && r.downSince && Date.now() - r.downSince > RECONNECT_AFTER_MS) {
      await closeConn(recv).catch(() => undefined);
      for (const id of [...audioEls.current.keys()]) dropAudio(id);
      pulled.current.clear();
      byMid.current.clear();
      // The next reconcile opens a fresh connection and pulls everything.
      await fetchState();
      await reconcile().catch(() => undefined);
      setNotice('RECONNECTED');
    }
    const s = send.current;
    if (s && s.downSince && Date.now() - s.downSince > RECONNECT_AFTER_MS) {
      const kinds = [...local.current.entries()].map(([k, l]) => [k, l.track] as const);
      await closeConn(send).catch(() => undefined);
      local.current.clear();
      for (const [k, t] of kinds) {
        if (t.readyState === 'live') await publish(k, t).catch(() => undefined);
      }
    }
  }, [closeConn, openRecv, fetchState, reconcile, publish, dropAudio]);

  // Tear down with the page.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      if (joinedRef.current) {
        void teardown();
        void api.post(`/live/${liveSessionId}/leave`).catch(() => undefined);
      }
    };
  }, [enabled, liveSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server says something changed: read the state, then pull what it says.
  useEffect(() => {
    if (!enabled || !joined) return;
    const sock = getSocket();
    let h: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (h) return;
      // Jittered, so a class of fifty does not ask in the same millisecond.
      h = setTimeout(
        async () => {
          h = null;
          const before = stateRef.current;
          const s = await fetchState();
          if (!s) return;
          if (before && s.run !== before.run) {
            // The class was reopened: a new run, so new connections.
            await teardown();
            setEnded(true);
            return;
          }
          // No longer allowed to speak: whatever was being sent stops here too
          // (the server has already closed it at the SFU).
          if (s.me.role === 'STUDENT' && !s.me.canPublish && send.current) await stopSending();
          await reconcile().catch(() => undefined);
        },
        150 + Math.random() * 600,
      );
    };
    const onState = (p: { sessionId: string }) => p?.sessionId === liveSessionId && refresh();
    const onHand = (p: { sessionId: string; state: HandState }) => {
      if (p?.sessionId !== liveSessionId) return;
      if (p.state === 'APPROVED_TO_SPEAK') setNotice('HAND_APPROVED');
      if (p.state === 'RELEASED' || p.state === 'IDLE') {
        if (send.current) setNotice('HAND_RELEASED');
      }
      refresh();
    };
    const onRemoved = (p: { sessionId: string }) => {
      if (p?.sessionId !== liveSessionId) return;
      void teardown().then(() => setEnded(true));
    };
    sock?.on('live:rtc-state', onState);
    sock?.on('live:hand', onHand);
    sock?.on('live:removed', onRemoved);
    sock?.on('connect', refresh);
    const poll = setInterval(refresh, STATE_POLL_MS);
    const net = setInterval(() => {
      // Said out loud (aria-live on the page) while a connection is down.
      const down = [recv.current, send.current].some(
        (c) => c && !c.closed && c.downSince != null,
      );
      setConnection(down ? 'reconnecting' : 'connected');
      void reconnect();
    }, 2_000);
    return () => {
      sock?.off('live:rtc-state', onState);
      sock?.off('live:hand', onHand);
      sock?.off('live:removed', onRemoved);
      sock?.off('connect', refresh);
      clearInterval(poll);
      clearInterval(net);
      if (h) clearTimeout(h);
    };
  }, [enabled, joined, liveSessionId, fetchState, reconcile, teardown, stopSending, reconnect]);

  // The teacher's camera layer: down on a weak link, back up when it recovers.
  useEffect(() => {
    if (!enabled || !joined) return;
    const last = new Map<string, { lost: number; recv: number; freezes: number }>();
    const h = setInterval(async () => {
      const c = recv.current;
      if (!c || c.closed) return;
      const layered = [...pulled.current.entries()].filter(([, p]) => p.layer);
      if (!layered.length) return;
      let stats: RTCStatsReport;
      try {
        stats = await c.pc.getStats();
      } catch {
        return;
      }
      let incomingKbps: number | null = null;
      const byMidStats = new Map<string, { lost: number; recv: number; freezes: number }>();
      stats.forEach((x: any) => {
        if (x.type === 'candidate-pair' && x.nominated && x.availableIncomingBitrate) {
          incomingKbps = x.availableIncomingBitrate / 1000;
        }
        if (x.type === 'inbound-rtp' && x.kind === 'video' && x.mid != null) {
          byMidStats.set(String(x.mid), {
            lost: x.packetsLost ?? 0,
            recv: x.packetsReceived ?? 0,
            freezes: x.freezeCount ?? 0,
          });
        }
      });
      const now = Date.now();
      for (const [trackId, p] of layered) {
        const cur = byMidStats.get(p.mid);
        if (!cur) continue;
        const prev = last.get(trackId);
        last.set(trackId, cur);
        if (!prev) continue;
        const lost = Math.max(0, cur.lost - prev.lost);
        const got = Math.max(0, cur.recv - prev.recv);
        const next = nextLayer(
          p.layer!,
          {
            lossPct: lost + got ? (100 * lost) / (lost + got) : 0,
            freezes: Math.max(0, cur.freezes - prev.freezes),
            incomingKbps,
          },
          now,
        );
        if (next.rid !== p.layer!.rid) {
          try {
            await api.post(`${base}/connections/${c.id}/layer`, {
              trackId,
              mid: p.mid,
              rid: next.rid,
            });
            p.layer = next;
          } catch {
            // Not switched; asked again on the next look.
          }
        } else {
          p.layer = next;
        }
      }
    }, LAYER_CHECK_MS);
    return () => clearInterval(h);
  }, [enabled, joined, base]);

  // Presence — the same heartbeat attendance has always been counted from.
  useEffect(() => {
    if (!enabled || !joined) return;
    const beat = () =>
      void api
        .post(`/live/${liveSessionId}/heartbeat`)
        .then(({ data }) => {
          if (data?.timing) onTimingRef.current?.(data.timing);
        })
        .catch(() => undefined);
    beat();
    const h = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(h);
  }, [enabled, joined, liveSessionId]);

  // Start and stop capturing the lesson's words as the server says: the mode
  // (OFF / MANUAL / AUTO_WHEN_RECORDING) is decided there, once, for the
  // badge, this page and the upload alike. Stopping flushes the piece being
  // written.
  const shouldCapture = enabled && joined && mayCapture && !ended && !!state?.transcribing;
  useEffect(() => {
    if (shouldCapture && !lessonAudio.current) {
      const la = new LessonAudio(
        (seq, blob, durationMs) => {
          const form = new FormData();
          form.append('file', blob, blob.type.includes('mp4') ? 'piece.m4a' : 'piece.webm');
          if (durationMs) form.append('durationMs', String(Math.round(durationMs)));
          return api.post(`/teacher/live/${liveSessionId}/audio/${seq}`, form).then(() => undefined);
        },
        undefined,
        idbPieceStore(),
        liveSessionId,
      );
      if (la.start()) {
        lessonAudio.current = la;
        setCapturing(true);
        // A piece interrupted by a reload or a crash of this page: sent now.
        void la.recover();
      }
    } else if (!shouldCapture && lessonAudio.current) {
      stopCapture();
    }
  }, [shouldCapture, liveSessionId, stopCapture]);

  /** MANUAL mode: the teacher switches capture on or off. */
  const setTranscriptCapture = useCallback(
    async (on: boolean) => {
      try {
        await api.patch(`/teacher/live/${liveSessionId}/transcription`, { capture: on });
      } catch {
        setNotice('TRANSCRIPT_FAILED');
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  // The lesson's audio: whatever is being said now — the teacher's microphone
  // and every voice pulled in — follows mutes, speakers granted and revoked.
  useEffect(() => {
    if (!capturing) return;
    const sync = () => {
      const tracks: MediaStreamTrack[] = [];
      const mic = local.current.get('AUDIO')?.track;
      if (mic) tracks.push(mic);
      for (const p of pulled.current.values()) if (p.kind === 'AUDIO' && p.track) tracks.push(p.track);
      lessonAudio.current?.setTracks(tracks);
    };
    sync();
    const h = setInterval(sync, 1_500);
    return () => clearInterval(h);
  }, [capturing]);

  // The class ended: the last piece goes up now, inside the server's grace.
  useEffect(() => {
    if (ended) stopCapture();
  }, [ended, stopCapture]);

  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(h);
  }, [notice]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const toggleMic = useCallback(async () => {
    if (local.current.has('AUDIO')) {
      setMicOn(false);
      await unpublish('AUDIO');
      return;
    }
    if (!stateRef.current?.me.canPublish) {
      setNotice('NOT_ALLOWED_TO_SPEAK');
      return;
    }
    try {
      const mic = await getMic();
      await publish('AUDIO', mic);
      setMicOn(true);
    } catch (e) {
      setNotice(errCode(e) === 'NOT_ALLOWED_TO_SPEAK' ? 'NOT_ALLOWED_TO_SPEAK' : 'MIC_FAILED');
    }
  }, [publish, unpublish]);

  const toggleCam = useCallback(async () => {
    if (local.current.has('VIDEO')) {
      setCamOn(false);
      await unpublish('VIDEO');
      return;
    }
    if (!stateRef.current?.me.canPublish) {
      setNotice('NOT_ALLOWED_TO_SPEAK');
      return;
    }
    try {
      const cam = await getCam(stateRef.current.me.role === 'TEACHER');
      await publish('VIDEO', cam);
      setCamOn(true);
    } catch (e) {
      setNotice(errCode(e) === 'NOT_ALLOWED_TO_SPEAK' ? 'NOT_ALLOWED_TO_SPEAK' : 'CAM_FAILED');
    }
  }, [publish, unpublish]);

  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const toggleShare = useCallback(async () => {
    if (local.current.has('SCREEN')) {
      setSharing(false);
      await unpublish('SCREEN');
      if (local.current.has('SCREEN_AUDIO')) await unpublish('SCREEN_AUDIO');
      return;
    }
    if (!canShare) {
      setNotice('SHARE_UNSUPPORTED');
      return;
    }
    if (stateRef.current?.me.role !== 'TEACHER') return;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 8, max: 15 } },
        audio: true,
      });
      const v = s.getVideoTracks()[0];
      // The browser's own "stop sharing" bar ends it too.
      v.addEventListener('ended', () => {
        setSharing(false);
        void unpublish('SCREEN');
        if (local.current.has('SCREEN_AUDIO')) void unpublish('SCREEN_AUDIO');
      });
      await publish('SCREEN', v);
      const a = s.getAudioTracks()[0];
      if (a) await publish('SCREEN_AUDIO', a);
      setSharing(true);
    } catch (e: any) {
      const name = e?.name ?? '';
      if (name === 'NotAllowedError' || name === 'AbortError') return;
      setNotice('SHARE_FAILED');
    }
  }, [canShare, publish, unpublish]);

  // ── Raise hand ────────────────────────────────────────────────────────────

  const raiseHand = useCallback(async () => {
    try {
      await api.post(`/live/${liveSessionId}/hand`, { action: 'raise' });
    } catch {
      setNotice('HAND_FAILED');
    }
    await fetchState();
  }, [liveSessionId, fetchState]);

  /** Lower a raised hand, or stop speaking. */
  const lowerHand = useCallback(async () => {
    try {
      await api.post(`/live/${liveSessionId}/hand`, { action: 'lower' });
    } catch {
      /* already lowered */
    }
    if (send.current) await stopSending();
    await fetchState();
  }, [liveSessionId, fetchState, stopSending]);

  const decideHand = useCallback(
    async (userId: string, action: 'approve' | 'reject' | 'revoke') => {
      try {
        await api.post(`/live/${liveSessionId}/hand/${userId}`, { action });
      } catch (e) {
        setNotice(errCode(e) === 'SPEAKER_LIMIT' ? 'SPEAKER_LIMIT' : 'HAND_FAILED');
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** "Mute" in a class is taking the floor back. */
  const muteParticipant = useCallback(
    (userId: string) => void decideHand(userId, 'revoke'),
    [decideHand],
  );
  const removeParticipant = useCallback(
    (userId: string) => {
      void api
        .post(`${base}/remove/${userId}`)
        .catch(() => setNotice('REMOVE_FAILED'))
        .then(() => fetchState());
    },
    [base, fetchState],
  );

  // ── What the page draws ───────────────────────────────────────────────────

  const me = state?.me.userId;
  const participants: Participant[] = (state?.participants ?? []).map((p) => {
    const isMe = p.userId === me;
    if (isMe) {
      return {
        sessionId: p.userId,
        userId: p.userId,
        name: p.name,
        local: true,
        owner: p.role === 'TEACHER',
        audio: micOn,
        video: camOn,
        screen: sharing,
        track: local.current.get('VIDEO')?.track ?? null,
        screenTrack: local.current.get('SCREEN')?.track ?? null,
      };
    }
    const mine = [...pulled.current.values()].filter((x) => x.userId === p.userId);
    const video = mine.find((x) => x.kind === 'VIDEO')?.track ?? null;
    const screen = mine.find((x) => x.kind === 'SCREEN')?.track ?? null;
    return {
      sessionId: p.userId,
      userId: p.userId,
      name: p.name,
      local: false,
      owner: p.role === 'TEACHER',
      audio: p.audio,
      video: p.video && !!video,
      screen: p.screen && !!screen,
      track: video,
      screenTrack: screen,
    };
  });
  // Before the first state arrives (the pre-join screen): the preview only.
  if (!state && preview) {
    participants.push({
      sessionId: 'local',
      userId: null,
      name: '',
      local: true,
      owner: true,
      audio: false,
      video: true,
      screen: false,
      track: preview,
      screenTrack: null,
    });
  }

  return {
    provider: 'cloudflare' as const,
    participants,
    joined,
    ended,
    setEnded,
    error,
    notice,
    canShare,
    micOn,
    camOn,
    sharing,
    startPreview,
    join,
    leave,
    toggleMic,
    toggleCam,
    toggleShare,
    recording: !!state?.recording,
    // Everyone sees it; the teacher's page is the one capturing.
    transcribing: capturing || !!state?.transcribing,
    transcription: state?.transcription ?? null,
    setTranscriptCapture,
    // Darsly's recorder runs on the server (the page asks for it through the
    // recording endpoint); there is nothing to start in the browser.
    startRecording: async (): Promise<string | null> => null,
    stopRecording: async () => undefined,
    muteParticipant,
    removeParticipant,
    ready: enabled,
    // Cloudflare only:
    rtc: state,
    hands: (state?.participants ?? []).filter((p) => p.hand !== 'IDLE' && p.role === 'STUDENT'),
    raiseHand,
    lowerHand,
    decideHand,
    audioBlocked,
    resumeAudio,
    connection,
  };
}

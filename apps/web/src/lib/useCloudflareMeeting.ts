import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';
import type { Participant } from './useDailyMeeting';

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
}

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
        const c = recv.current;
        if (!s || !c || c.closed || !joinedRef.current) return;
        const me = s.me.userId;
        const want = new Map(s.tracks.filter((t) => t.userId !== me).map((t) => [t.id, t]));
        const add = [...want.keys()].filter((id) => !pulled.current.has(id));
        const drop = [...pulled.current.keys()].filter((id) => !want.has(id));

        if (drop.length) {
          await c.run(async () => {
            const mids: string[] = [];
            for (const id of drop) {
              const p = pulled.current.get(id)!;
              pulled.current.delete(id);
              dropAudio(id);
              mids.push(p.mid);
              const tr = c.pc.getTransceivers().find((x) => x.mid === p.mid);
              try {
                tr?.stop();
              } catch {
                /* already stopped */
              }
            }
            try {
              const offer = await c.pc.createOffer();
              await c.pc.setLocalDescription(offer);
              const r = (
                await api.post(`${base}/connections/${c.id}/close-tracks`, {
                  mids,
                  offer: { type: 'offer', sdp: offer.sdp },
                })
              ).data;
              if (r.sessionDescription) await c.pc.setRemoteDescription(r.sessionDescription);
            } catch {
              // The publisher is gone already; the SFU has nothing to close.
            }
          });
          bump();
        }

        if (add.length) {
          await c.run(async () => {
            let r: any;
            try {
              r = (await api.post(`${base}/connections/${c.id}/subscribe`, { trackIds: add })).data;
            } catch (e) {
              if (errCode(e) === 'RTC_TRACKS_GONE') {
                again.current = true;
                await fetchState();
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
              const p: Pulled = { mid: t.mid, kind: info.kind, userId: info.userId, track: null };
              pulled.current.set(t.trackId, p);
            }
            if (r.requiresImmediateRenegotiation && r.sessionDescription) {
              await c.pc.setRemoteDescription(r.sessionDescription);
              const answer = await c.pc.createAnswer();
              await c.pc.setLocalDescription(answer);
              await api.put(`${base}/connections/${c.id}/renegotiate`, {
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
  const publish = useCallback(
    async (kind: Kind, track: MediaStreamTrack) => {
      const c = send.current ?? (await openSend());
      await c.run(async () => {
        const encodings: RTCRtpEncodingParameters[] | undefined =
          kind === 'VIDEO'
            ? [{ maxBitrate: stateRef.current?.me.role === 'TEACHER' ? 1_200_000 : 350_000 }]
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
      bump();
    },
    [base, openSend, bump],
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
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => s.getAudioTracks()[0]);
  const getCam = (teacher: boolean) =>
    navigator.mediaDevices
      .getUserMedia({
        video: teacher
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }
          : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
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
        await openRecv();
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

  const teardown = useCallback(async () => {
    joinedRef.current = false;
    for (const [, l] of local.current) l.track.stop();
    local.current.clear();
    previewRef.current?.stop();
    previewRef.current = null;
    for (const id of [...audioEls.current.keys()]) dropAudio(id);
    pulled.current.clear();
    await Promise.all([closeConn(send), closeConn(recv)]);
    setJoined(false);
  }, [closeConn, dropAudio]);

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
      await openRecv().catch(() => undefined);
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
    const net = setInterval(() => void reconnect(), 2_000);
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
    transcribing: false,
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
  };
}

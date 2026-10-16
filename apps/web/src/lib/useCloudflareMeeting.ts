import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiKeepalive } from './api';
import { getSocket } from './socket';
import type { Participant } from './useDailyMeeting';
import { initialLayer, nextLayer, type LayerState } from './simulcast';
import { audioConstraint, videoConstraint } from './liveDevices';
import { LessonAudio } from './lessonAudio';
import { SpeakerCapture } from './speakerCapture';
import { idbPieceStore } from './lessonAudioStore';
import { PieceOutbox, type UploadOwed } from './lessonAudioOutbox';
import { lessonAudioContext, primeLessonAudio } from './lessonAudioContext';
import { DeviceMuteJudge, peakOf } from './deviceMute';
import { beginOp, markOp } from './liveTimings';

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
/**
 * The poll while the realtime socket is not connected (a network that blocks
 * WebSockets, a socket still connecting): the state is all the page has, so
 * it is read more often — or a teacher who just joined saw no tile of their
 * own, and a student no teacher, for up to the full 20 seconds.
 */
const STATE_POLL_NO_SOCKET_MS = 5_000;
/** How long a connection may sit disconnected before it is rebuilt. */
const RECONNECT_AFTER_MS = 4_000;
/** The capturing tab's heartbeat (its lease lasts 30 s on the server). */
const CAPTURE_BEAT_MS = 10_000;
/** Asking again for the capture of a class another tab holds. */
const CAPTURE_RECLAIM_MS = 15_000;
/** Owed pieces of the lesson's audio are tried again this often. */
const OUTBOX_RETRY_MS = 20_000;

/** This browser tab, stable across a reload (a duplicated tab gets a new one). */
function captureTabId(): string {
  const fresh = () =>
    globalThis.crypto?.randomUUID?.() ??
    `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  try {
    const k = 'darsly-capture-tab';
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = fresh();
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch {
    return fresh();
  }
}

/** One piece of the lesson's audio, to the server (its lease and speaker with it). */
const uploadPiece =
  (liveSessionId: string): UploadOwed =>
  (seq, blob, durationMs, speakerUserId, leaseId) => {
    const form = new FormData();
    form.append('file', blob, blob.type.includes('mp4') ? 'piece.m4a' : 'piece.webm');
    if (durationMs) form.append('durationMs', String(Math.round(durationMs)));
    // Whose microphone, as this page knows it — the server checks it.
    if (speakerUserId) form.append('speakerUserId', speakerUserId);
    if (leaseId) form.append('leaseId', leaseId);
    return api.post(`/teacher/live/${liveSessionId}/audio/${seq}`, form).then(() => undefined);
  };

export type CaptureStatus = 'off' | 'claiming' | 'on' | 'elsewhere';

type Kind = 'AUDIO' | 'VIDEO' | 'SCREEN' | 'SCREEN_AUDIO';
export type HandState =
  'IDLE' | 'HAND_RAISED' | 'APPROVED_TO_SPEAK' | 'ACTIVE_SPEAKER' | 'RELEASED';

export interface RtcState {
  sessionId: string;
  run: string;
  serverNow: string;
  me: {
    userId: string;
    role: 'TEACHER' | 'STUDENT';
    hand: HandState;
    canPublish: boolean;
    /** May run the class (the server's answer; it checks again on every action). */
    moderator?: boolean;
    /** What I may send and am asked to do (classroom-policy.ts on the server). */
    policy?: ClassroomPolicy;
    /** A student's own bonus points in this class. */
    bonus?: number;
  };
  maxSpeakers: number;
  /** The class's policies (explain the controls to everyone). */
  policies?: { mic: 'RAISE_HAND' | 'LISTEN_ONLY'; camera?: CameraPolicy };
  recording?: boolean;
  /** The teacher's view: the run's latest recording, as the recorder really has it. */
  recordingState?: {
    id: string;
    stage: string;
    failure: string | null;
    intent: boolean;
    requestedAt: string;
    captureStartedAt: string | null;
  };
  /** The teacher's view: which tab captures the lesson's audio. */
  captureLease?: {
    id: string;
    mine: boolean;
    tabId: string | null;
    audioOk: boolean;
    audioProblem: string | null;
  } | null;
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
    /** Moderators only: this participant's controls in this run (and what their page reported). */
    controls?: {
      mic: 'DEFAULT' | 'BLOCKED';
      camera?: 'DEFAULT' | 'EXEMPT' | 'BLOCKED';
      cameraReport?: 'DENIED' | 'NO_DEVICE' | 'FAILED' | null;
    };
    /** Moderators only: asked to have the camera on (EXPECTED, not exempt). */
    cameraExpected?: boolean;
    /** Moderators only: bonus points given in this class; a guest has no points. */
    bonus?: number;
    guest?: boolean;
  }[];
  /** `muted`: published but switched off by its sender (still pulled, so unmuting is instant). */
  tracks: {
    id: string;
    userId: string;
    kind: Kind;
    role: 'TEACHER' | 'STUDENT';
    muted?: boolean;
  }[];
  /** Moderators only: who holds a seat and is not in the room yet. */
  notJoined?: { userId: string; name: string; guest: boolean }[];
  /** Moderators only: students asking for a seat in a full class. */
  admissions?: {
    requests: {
      id: string;
      userId: string;
      name: string;
      status: 'PENDING' | 'APPROVED';
      requestedAt: string;
    }[];
    capacity: number | null;
    exceptions: number;
  };
}

export type CameraPolicy = 'SPEAKERS_ONLY' | 'OPTIONAL' | 'EXPECTED' | 'OFF';

/** A moderator's page pulls at most this many students' cameras at once (a page of them). */
export const STUDENT_CAMERA_PAGE = 8;

export interface ClassroomPolicy {
  publish: Record<Kind, boolean>;
  mayOpenSend: boolean;
  mayRaiseHand: boolean;
  speaker: boolean;
  cameraExpected: boolean;
  micBlocked: boolean;
  cameraBlocked: boolean;
  cameraExempt: boolean;
  videoAudience: 'EVERYONE' | 'MODERATORS';
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
  const [invited, setInvited] = useState(false);
  /** The teacher reminded me to turn my camera on (a prompt; I turn it on). */
  const [nudged, setNudged] = useState(false);
  /** What I last told the server about my camera (so a fix clears it once). */
  const cameraReported = useRef<string | null>(null);
  const cameraPageRef = useRef(0);
  const hiddenCamerasRef = useRef(0);
  const [cameraPage, setCameraPageState] = useState(0);
  /** A bonus just received (a student's page shows it, then it fades). */
  const [bonusReceived, setBonusReceived] = useState<{
    id: number;
    points: number;
    reasonKey: string | null;
    reason: string | null;
  } | null>(null);
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected');
  /** This page is capturing the lesson's audio for its transcript. */
  const [capturing, setCapturing] = useState(false);
  const lessonAudio = useRef<LessonAudio | SpeakerCapture | null>(null);
  /** The server allows this page to capture (the teacher, transcription on). */
  const [mayCapture, setMayCapture] = useState(false);
  /** This tab's capture of the lesson's audio: claiming its lease, on, or held by another tab. */
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('off');
  const leaseRef = useRef<string | null>(null);
  const claimingRef = useRef(false);
  const [claimTick, setClaimTick] = useState(0);
  const tabId = useRef<string>(captureTabId());
  /** Every piece made, owed until delivered — and what was made, told to the server. */
  const outbox = useMemo(
    () =>
      new PieceOutbox({
        session: liveSessionId,
        store: idbPieceStore(),
        upload: uploadPiece(liveSessionId),
      }),
    [liveSessionId],
  );
  const [captureStats, setCaptureStats] = useState(() => ({
    ...outbox.stats,
    audioOk: true,
    audioProblem: null as string | null,
  }));
  const recordingIntentRef = useRef(false);
  /** Camera / microphone being switched: what the teacher asked for, and whether it is under way. */
  const desired = useRef<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  const working = useRef<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  const [pendingDevice, setPendingDevice] = useState<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  /**
   * My microphone muted on the device itself (a laptop's mute key, the
   * system's mute): the switch shows it off and the room hears it is off.
   */
  const [micDeviceMuted, setMicDeviceMuted] = useState(false);
  const micDeviceMutedRef = useRef(false);
  /** My camera paused by the device (a privacy key that stops its frames). */
  const [camDeviceMuted, setCamDeviceMuted] = useState(false);
  /** Send the microphone muted ahead of the first unmute, so that one is instant too. */
  const warmMic = useRef(false);
  /** The mute last asked of the server, per kind, while one is in flight. */
  const muteWanted = useRef<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  const muteBusy = useRef<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  /** What the server was last told (at publish, or by a mute call that went through). */
  const muteTold = useRef<{ AUDIO?: boolean; VIDEO?: boolean }>({});
  /** Device events (ended / mute / unmute), set up once per track. */
  const deviceWatchRef = useRef<((kind: Kind, t: MediaStreamTrack) => void) | null>(null);
  const applyMicRef = useRef<(() => boolean) | null>(null);
  const convergeRef = useRef<((kind: 'AUDIO' | 'VIDEO') => Promise<void>) | null>(null);
  /** The self-view, on screen before the SFU has confirmed the camera. */
  const localPreview = useRef<MediaStreamTrack | null>(null);
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
          markOp(`recv:${trackId}`, `${p.kind}:${p.userId}`, 'remoteVisible');
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
        // The server already sends only the cameras this person may see. A
        // moderator may see every student's — but a phone need not pull twenty
        // streams: speakers' cameras, then one page of the rest.
        const speakers = new Set(
          s.participants
            .filter((p) => p.hand === 'APPROVED_TO_SPEAK' || p.hand === 'ACTIVE_SPEAKER')
            .map((p) => p.userId),
        );
        const studentCams = s.tracks.filter(
          (t) =>
            t.userId !== me &&
            t.kind === 'VIDEO' &&
            t.role === 'STUDENT' &&
            !speakers.has(t.userId),
        );
        const page = Math.min(
          cameraPageRef.current,
          Math.max(0, Math.ceil(studentCams.length / STUDENT_CAMERA_PAGE) - 1),
        );
        const shownCams = new Set(
          studentCams
            .slice(page * STUDENT_CAMERA_PAGE, (page + 1) * STUDENT_CAMERA_PAGE)
            .map((t) => t.id),
        );
        hiddenCamerasRef.current = studentCams.length - shownCams.size;
        const want = new Map(
          s.tracks
            .filter((t) => t.userId !== me)
            .filter(
              (t) =>
                !(t.kind === 'VIDEO' && t.role === 'STUDENT' && !speakers.has(t.userId)) ||
                shownCams.has(t.id),
            )
            .map((t) => [t.id, t]),
        );
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
            // A microphone sent switched off (joined muted) is published
            // muted: shown off, and on at once when it is switched on.
            tracks: [{ mid: tr.mid, kind, ...(track.enabled ? {} : { muted: true }) }],
          })
        ).data;
        await c.pc.setRemoteDescription(r.sessionDescription);
        const prev = local.current.get(kind);
        if (prev && prev.track !== track) prev.track.stop();
        local.current.set(kind, { track, mid: tr.mid });
        if (kind === 'AUDIO' || kind === 'VIDEO') muteTold.current[kind] = !track.enabled;
        deviceWatchRef.current?.(kind, track);
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
      // The last thing this browser sends (a student's camera alone, say):
      // the whole sending connection goes, and the server closes its tracks.
      // An offer with every track stopped has no BUNDLE group and would be
      // refused by the browser — the SFU would never hear of it.
      if (!local.current.size) {
        await closeConn(send);
        return;
      }
      await c.run(async () => {
        const tr = c.pc.getTransceivers().find((x) => x.mid === l.mid);
        try {
          tr?.stop();
        } catch {
          /* stopped */
        }
        let offer: RTCSessionDescriptionInit;
        try {
          offer = await c.pc.createOffer();
          await c.pc.setLocalDescription(offer);
        } catch {
          // This browser could not renegotiate: close the connection rather
          // than leave a stopped device "on" at the SFU. Anything else it was
          // sending goes with it (the controls say so).
          for (const [, other] of local.current) other.track.stop();
          local.current.clear();
          setMicOn(false);
          setCamOn(false);
          setSharing(false);
          await closeConn(send);
          return;
        }
        try {
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
    [base, bump, closeConn],
  );

  const unpublishRef = useRef<typeof unpublish | null>(null);
  unpublishRef.current = unpublish;

  /**
   * Tell the room my mute. The switch has already acted on the track itself
   * (instant); this only updates what the others' lists show. The last wish
   * wins: presses made while one is in flight are not each sent.
   */
  const syncMute = useCallback(
    (kind: 'AUDIO' | 'VIDEO', muted: boolean, force = false) => {
      // Already what the server holds: nothing to send (a press back and
      // forth while one call is in flight still sends the last one).
      if (!force && !muteBusy.current[kind] && muteTold.current[kind] === muted) return;
      muteWanted.current[kind] = muted;
      if (muteBusy.current[kind]) return;
      muteBusy.current[kind] = true;
      void (async () => {
        try {
          while (muteWanted.current[kind] !== undefined) {
            const m = muteWanted.current[kind]!;
            delete muteWanted.current[kind];
            const c = send.current;
            const l = local.current.get(kind);
            if (!c || c.closed || !l?.mid) break;
            await api
              .post(`${base}/connections/${c.id}/mute`, { mid: l.mid, muted: m })
              .then(() => {
                muteTold.current[kind] = m;
              })
              .catch(() => {
                delete muteTold.current[kind];
              });
          }
        } finally {
          muteBusy.current[kind] = false;
        }
      })();
    },
    [base],
  );

  /** My microphone is really being heard: sent, switched on, not muted on the device. */
  const micAudible = () => {
    const l = local.current.get('AUDIO');
    return !!l && l.track.readyState === 'live' && l.track.enabled && !micDeviceMutedRef.current;
  };

  /**
   * The microphone as wanted, at once — the way a call app does it: the
   * track stays sent and is switched on or off in place (no device to open,
   * no SFU round trip), then the room is told. False when nothing is sent yet.
   */
  const applyMic = useCallback(() => {
    const l = local.current.get('AUDIO');
    if (!l || l.track.readyState !== 'live') return false;
    l.track.enabled = !!desired.current.AUDIO;
    const on = micAudible();
    setMicOn(on);
    syncMute('AUDIO', !on);
    return true;
  }, [syncMute]);
  applyMicRef.current = applyMic;

  /** The device muted (or unmuted) my microphone: shown and told, never fought. */
  const markMicDeviceMuted = useCallback(
    (v: boolean) => {
      if (micDeviceMutedRef.current === v) return;
      micDeviceMutedRef.current = v;
      setMicDeviceMuted(v);
      const l = local.current.get('AUDIO');
      if (!l || !l.track.enabled) return;
      if (v) setNotice('MIC_DEVICE_MUTED');
      setMicOn(!v);
      syncMute('AUDIO', v);
    },
    [syncMute],
  );

  // What the device does to my camera and microphone reaches the switches:
  // unplugged or taken away (ended), or paused by the device (mute / unmute).
  deviceWatchRef.current = (kind, t) => {
    if (kind !== 'AUDIO' && kind !== 'VIDEO') return;
    const w = t as MediaStreamTrack & { __darslyWatched?: boolean };
    if (w.__darslyWatched) return;
    w.__darslyWatched = true;
    const mine = () => local.current.get(kind)?.track === t;
    t.addEventListener('ended', () => {
      if (!mine()) return;
      desired.current[kind] = false;
      if (kind === 'AUDIO') {
        markMicDeviceMuted(false);
        setMicOn(false);
        setNotice('MIC_LOST');
      } else {
        setCamDeviceMuted(false);
        setCamOn(false);
        setNotice('CAM_LOST');
      }
      void unpublishRef.current?.(kind);
    });
    t.addEventListener('mute', () => {
      if (!mine()) return;
      if (kind === 'AUDIO') markMicDeviceMuted(true);
      else {
        setCamDeviceMuted(true);
        setNotice('CAM_DEVICE_MUTED');
        syncMute('VIDEO', true);
      }
    });
    t.addEventListener('unmute', () => {
      if (!mine()) return;
      if (kind === 'AUDIO') markMicDeviceMuted(false);
      else {
        setCamDeviceMuted(false);
        syncMute('VIDEO', false);
      }
    });
  };

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
      // From the "join" click: the audio context that tells a device-muted
      // microphone (and later captures the lesson) starts here.
      primeLessonAudio();
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
          desired.current.AUDIO = o.mic;
          if (o.mic) {
            const mic = await getMic().catch(() => null);
            if (mic) {
              await publish('AUDIO', mic);
              applyMicRef.current?.();
            } else setNotice('MIC_FAILED');
          } else if (await micPermissionGranted()) {
            // Joined muted: the microphone goes out switched off now, so the
            // first unmute is as instant as every other (only when the browser
            // already has the permission — nothing is asked here).
            warmMic.current = true;
            void convergeRef.current?.('AUDIO');
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

  /**
   * The last piece of the lesson's audio is sent; capture stops, and the
   * lease is given back (unless it was lost to another tab). Not awaited:
   * the upload finishes in the background while the page moves on, and
   * whatever it cannot deliver stays owed (lessonAudioOutbox.ts).
   */
  const stopCapture = useCallback(
    (release = true) => {
      const la = lessonAudio.current;
      lessonAudio.current = null;
      setCapturing(false);
      const leaseId = leaseRef.current;
      leaseRef.current = null;
      setCaptureStatus((s) => (s === 'elsewhere' ? s : 'off'));
      void (async () => {
        if (la) await la.stop();
        await outbox.flush().catch(() => undefined);
        if (!leaseId || !release) return;
        const pieces = outbox.drainReports();
        await api
          .post(`/teacher/live/${liveSessionId}/capture/release`, {
            leaseId,
            tabId: tabId.current,
            stats: { ...outbox.stats },
            pieces: pieces.slice(0, 200),
          })
          .catch(() => outbox.requeueReports(pieces));
      })();
    },
    [outbox, liveSessionId],
  );

  const teardown = useCallback(async () => {
    joinedRef.current = false;
    stopCapture();
    for (const [, l] of local.current) l.track.stop();
    local.current.clear();
    previewRef.current?.stop();
    previewRef.current = null;
    localPreview.current?.stop();
    localPreview.current = null;
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
          // No longer allowed to send something: it stops here too (the server
          // has already closed it at the SFU). Only what is no longer allowed —
          // losing the floor takes the microphone, not a camera still allowed.
          if (s.me.role === 'STUDENT' && send.current) {
            if (!s.me.canPublish) await stopSending();
            else if (s.me.policy) {
              for (const kind of [...local.current.keys()]) {
                if (!s.me.policy.publish[kind]) {
                  if (kind === 'AUDIO' || kind === 'VIDEO') desired.current[kind] = false;
                  if (kind === 'AUDIO') setMicOn(false);
                  if (kind === 'VIDEO') setCamOn(false);
                  await unpublishRef.current?.(kind);
                }
              }
            }
          }
          // The room's view of my microphone drifted from the switch (a mute
          // call lost, a connection replaced): told again.
          const mic = local.current.get('AUDIO');
          const mine = s.participants.find((p) => p.userId === s.me.userId);
          if (mic?.mid && mine && !muteBusy.current.AUDIO && mine.audio !== micAudible()) {
            syncMute('AUDIO', !micAudible(), true);
          }
          await reconcile().catch(() => undefined);
        },
        150 + Math.random() * 600,
      );
    };
    const onState = (p: { sessionId: string }) => p?.sessionId === liveSessionId && refresh();
    const onHand = (p: { sessionId: string; state: HandState; invited?: boolean }) => {
      if (p?.sessionId !== liveSessionId) return;
      // An invitation is asked on the page; the student's click is what publishes.
      setInvited(p.state === 'APPROVED_TO_SPEAK' && !!p.invited);
      if (p.state === 'APPROVED_TO_SPEAK' && !p.invited) setNotice('HAND_APPROVED');
      if (p.state === 'RELEASED' || p.state === 'IDLE') {
        if (send.current) setNotice('HAND_RELEASED');
      }
      refresh();
    };
    const onBonus = (p: {
      sessionId: string;
      points: number;
      reasonKey: string | null;
      reason: string | null;
    }) => {
      if (p?.sessionId !== liveSessionId) return;
      const id = Date.now();
      setBonusReceived({ id, points: p.points, reasonKey: p.reasonKey, reason: p.reason });
      setTimeout(() => setBonusReceived((cur) => (cur?.id === id ? null : cur)), 6_000);
      refresh();
    };
    const onNudge = (p: { sessionId: string; kind: string }) => {
      if (p?.sessionId !== liveSessionId || p.kind !== 'CAMERA') return;
      setNudged(true);
      setTimeout(() => setNudged(false), 20_000);
    };
    const onRemoved = (p: { sessionId: string }) => {
      if (p?.sessionId !== liveSessionId) return;
      void teardown().then(() => setEnded(true));
    };
    sock?.on('live:rtc-state', onState);
    sock?.on('live:hand', onHand);
    sock?.on('live:bonus', onBonus);
    sock?.on('live:nudge', onNudge);
    sock?.on('live:removed', onRemoved);
    sock?.on('connect', refresh);
    // Joined: the room as it is now, with us in it — the state read before
    // joining did not have us yet, and the socket may never tell us.
    refresh();
    let lastPoll = Date.now();
    const poll = setInterval(() => {
      const due = sock?.connected ? STATE_POLL_MS : STATE_POLL_NO_SOCKET_MS;
      if (Date.now() - lastPoll < due) return;
      lastPoll = Date.now();
      refresh();
    }, STATE_POLL_NO_SOCKET_MS);
    const net = setInterval(() => {
      // Said out loud (aria-live on the page) while a connection is down.
      const down = [recv.current, send.current].some((c) => c && !c.closed && c.downSince != null);
      setConnection(down ? 'reconnecting' : 'connected');
      void reconnect();
    }, 2_000);
    return () => {
      sock?.off('live:rtc-state', onState);
      sock?.off('live:hand', onHand);
      sock?.off('live:bonus', onBonus);
      sock?.off('live:nudge', onNudge);
      sock?.off('live:removed', onRemoved);
      sock?.off('connect', refresh);
      clearInterval(poll);
      clearInterval(net);
      if (h) clearTimeout(h);
    };
  }, [
    enabled,
    joined,
    liveSessionId,
    fetchState,
    reconcile,
    teardown,
    stopSending,
    reconnect,
    syncMute,
  ]);

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
  // badge, this page and the upload alike. Capture starts only once this tab
  // holds the class's capture lease — a second tab or device is told another
  // one has it, instead of recording the lesson twice. Stopping flushes the
  // piece being written.
  const shouldCapture = enabled && joined && mayCapture && !ended && !!state?.transcribing;
  const myUserId = state?.me.userId;
  useEffect(() => {
    if (shouldCapture && !lessonAudio.current && myUserId && !claimingRef.current) {
      claimingRef.current = true;
      setCaptureStatus('claiming');
      void api
        .post(`/teacher/live/${liveSessionId}/capture/claim`, { tabId: tabId.current })
        .then(({ data }) => {
          if (lessonAudio.current) return;
          leaseRef.current = data.leaseId;
          outbox.setLease(data.leaseId);
          const upload = uploadPiece(liveSessionId);
          // Each microphone on its own (who said what); the mixed capture when
          // this browser cannot. Both report every piece to the outbox.
          const sc = new SpeakerCapture(
            (q, b, ms, spk) => upload(q, b, ms ?? 0, spk, data.leaseId),
            myUserId,
            idbPieceStore(),
            liveSessionId,
            outbox,
          );
          const la = sc.start()
            ? sc
            : new LessonAudio(
                (q, b, ms) => upload(q, b, ms ?? 0, undefined, data.leaseId),
                undefined,
                idbPieceStore(),
                liveSessionId,
                outbox,
              );
          if (la === sc || (la as LessonAudio).start()) {
            lessonAudio.current = la;
            setCapturing(true);
            setCaptureStatus('on');
            // A piece left by a reload or a crash of this page: sent now.
            void outbox.flush(la.currentIds());
          } else {
            // This browser cannot record audio at all: said, never pretended.
            outbox.health(false, 'NO_RECORDER');
            setCaptureStatus('off');
            setNotice('TRANSCRIPT_FAILED');
          }
        })
        .catch((e) => {
          setCaptureStatus(errCode(e) === 'CAPTURE_ELSEWHERE' ? 'elsewhere' : 'off');
        })
        .finally(() => {
          claimingRef.current = false;
        });
    } else if (!shouldCapture && lessonAudio.current) {
      stopCapture();
    } else if (!shouldCapture) {
      setCaptureStatus('off');
    }
  }, [shouldCapture, myUserId, liveSessionId, stopCapture, outbox, claimTick]);

  // Not capturing although it should be (another tab holds it, or a claim
  // failed): ask again every little while — the other tab may have closed.
  useEffect(() => {
    if (!shouldCapture || capturing) return;
    const h = setInterval(() => setClaimTick((n) => n + 1), CAPTURE_RECLAIM_MS);
    return () => clearInterval(h);
  }, [shouldCapture, capturing]);

  // The capturing tab's heartbeat: still here, the pieces it made, whether its
  // audio really runs. A lease lost to another tab stops this one's capture.
  useEffect(() => {
    if (captureStatus !== 'on') return;
    const beat = async () => {
      const leaseId = leaseRef.current;
      if (!leaseId) return;
      const all = outbox.drainReports();
      const pieces = all.slice(0, 200);
      if (all.length > 200) outbox.requeueReports(all.slice(200));
      try {
        await api.post(`/teacher/live/${liveSessionId}/capture/beat`, {
          leaseId,
          tabId: tabId.current,
          audioOk: outbox.audioOk,
          audioProblem: outbox.audioProblem,
          stats: { ...outbox.stats },
          pieces,
        });
      } catch (e) {
        outbox.requeueReports(pieces);
        if (errCode(e) === 'CAPTURE_LEASE_LOST') {
          stopCapture(false);
          setCaptureStatus('elsewhere');
        }
      }
    };
    void beat();
    const h = setInterval(() => void beat(), CAPTURE_BEAT_MS);
    return () => clearInterval(h);
  }, [captureStatus, liveSessionId, outbox, stopCapture]);

  // Owed pieces go when they can: on opening the class (a reload, a crash, the
  // next visit), when the connection comes back, and every little while.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => void outbox.flush(lessonAudio.current?.currentIds() ?? []);
    flush();
    const off = outbox.onChange(() =>
      setCaptureStats({
        ...outbox.stats,
        audioOk: outbox.audioOk,
        audioProblem: outbox.audioProblem,
      }),
    );
    window.addEventListener('online', flush);
    const h = setInterval(() => {
      if (outbox.stats.pending > 0) flush();
    }, OUTBOX_RETRY_MS);
    return () => {
      off();
      window.removeEventListener('online', flush);
      clearInterval(h);
    };
  }, [enabled, outbox]);

  // The page closing while the lesson's audio is captured here: warned first
  // (where the browser allows), and what the recorder holds is handed to the
  // store so the next visit can still send it.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      lessonAudio.current?.flushForUnload();
      const leaseId = leaseRef.current;
      if (!leaseId) return;
      apiKeepalive(`/teacher/live/${liveSessionId}/capture/beat`, {
        leaseId,
        tabId: tabId.current,
        audioOk: outbox.audioOk,
        audioProblem: outbox.audioProblem,
        stats: { ...outbox.stats },
        pieces: outbox.drainReports().slice(0, 200),
      });
    };
    const onBefore = (e: BeforeUnloadEvent) => {
      if (lessonAudio.current || outbox.stats.pending > 0 || recordingIntentRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onBefore);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onBefore);
    };
  }, [enabled, liveSessionId, outbox]);

  useEffect(() => {
    recordingIntentRef.current = !!state?.recordingState?.intent;
  }, [state?.recordingState?.intent]);

  /** MANUAL mode: the teacher switches capture on or off. */
  const setTranscriptCapture = useCallback(
    async (on: boolean) => {
      // From the teacher's click: the audio context may start here.
      if (on) primeLessonAudio();
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
      const la = lessonAudio.current;
      const me = stateRef.current?.me.userId;
      const mics: { userId: string; track: MediaStreamTrack }[] = [];
      const mic = local.current.get('AUDIO')?.track;
      // A muted microphone is still sent (silence): it is not the lesson.
      if (mic && me && micAudible()) mics.push({ userId: me, track: mic });
      const mutedIds = new Set(
        (stateRef.current?.tracks ?? []).filter((t) => t.muted).map((t) => t.id),
      );
      for (const [id, p] of pulled.current)
        if (p.kind === 'AUDIO' && p.track && !mutedIds.has(id))
          mics.push({ userId: p.userId, track: p.track });
      if (la instanceof SpeakerCapture) la.setTracks(mics);
      else la?.setTracks(mics.map((m) => m.track));
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

  /**
   * Bring one device to what the teacher asked for, one change at a time.
   *
   * A press records what is wanted; whatever is running finishes and the
   * loop goes again until the device matches the last press. So ON → OFF →
   * ON pressed quickly is one camera, never two publishes racing each other
   * (each used to start its own getUserMedia and push a second track).
   */
  const converge = useCallback(
    async (kind: 'AUDIO' | 'VIDEO') => {
      if (working.current[kind]) return;
      working.current[kind] = true;
      // Sending the microphone ahead (muted) is not a press: no spinner for it.
      if (kind === 'VIDEO' || desired.current.AUDIO)
        setPendingDevice((p) => ({ ...p, [kind]: true }));
      try {
        for (let i = 0; i < 6; i++) {
          const want = !!desired.current[kind];
          const have = local.current.has(kind);
          // The microphone is sent once and then switched in place (applyMic);
          // here it is only opened and sent — when wanted, or sent ahead muted.
          if (kind === 'AUDIO') {
            if (have || (!want && !warmMic.current)) break;
          } else if (want === have) break;
          const op = beginOp(kind === 'VIDEO' ? 'camera' : 'mic');
          if (!want && kind === 'VIDEO') {
            if (kind === 'VIDEO') setCamOn(false);
            else setMicOn(false);
            await unpublish(kind);
            markOp(op, kind, 'unpublished');
            continue;
          }
          const me = stateRef.current?.me;
          if (!me?.canPublish || (me.policy && !me.policy.publish[kind])) {
            if (kind === 'AUDIO' && !want) {
              // Only sending ahead: not allowed yet is nothing to say.
              warmMic.current = false;
              markOp(op, kind, 'failed');
              break;
            }
            setNotice(
              kind === 'AUDIO' && me?.policy?.micBlocked ? 'MIC_BLOCKED' : 'NOT_ALLOWED_TO_SPEAK',
            );
            desired.current[kind] = false;
            markOp(op, kind, 'failed');
            break;
          }
          let track: MediaStreamTrack;
          try {
            track = kind === 'VIDEO' ? await getCam(me.role === 'TEACHER') : await getMic();
          } catch (e) {
            const asked = !!desired.current[kind];
            desired.current[kind] = false;
            markOp(op, kind, 'failed');
            if (kind === 'AUDIO') {
              warmMic.current = false;
              if (asked) setNotice('MIC_FAILED');
              break;
            }
            setNotice('CAM_FAILED');
            // Told to the teacher, as the device reported it (never a reason to remove anyone).
            const name = (e as { name?: string })?.name;
            const report =
              name === 'NotAllowedError' || name === 'SecurityError'
                ? 'DENIED'
                : name === 'NotFoundError' || name === 'OverconstrainedError'
                  ? 'NO_DEVICE'
                  : 'FAILED';
            if (me.role === 'STUDENT' && cameraReported.current !== report) {
              cameraReported.current = report;
              void api.post(`${base}/device-report`, { camera: report }).catch(() => undefined);
            }
            break;
          }
          markOp(op, kind, 'deviceReady');
          // Asked off again while the camera was opening: nothing to send. (A
          // microphone still goes out — switched off — so its next "on" is instant.)
          if (kind === 'VIDEO' && !desired.current[kind]) {
            track.stop();
            markOp(op, kind, 'unpublished');
            continue;
          }
          if (kind === 'VIDEO') {
            // The self-view is the teacher's own camera: shown the moment it
            // opens, not after the SFU round trip (it still says "connecting"
            // through the pending state until the class can see it).
            localPreview.current?.stop();
            localPreview.current = track;
            setCamOn(true);
            bump();
            markOp(op, kind, 'localPreview');
          }
          if (kind === 'AUDIO') track.enabled = !!desired.current.AUDIO;
          try {
            markOp(op, kind, 'publishRequest');
            await publish(kind, track);
            markOp(op, kind, 'sfuConfirmed');
            if (kind === 'VIDEO') {
              if (localPreview.current === track) localPreview.current = null;
              setNudged(false);
              if (cameraReported.current) {
                cameraReported.current = null;
                void api.post(`${base}/device-report`, { camera: null }).catch(() => undefined);
              }
            } else {
              warmMic.current = false;
              // Pressed again while it was being sent: the last press wins.
              applyMic();
            }
          } catch (e) {
            track.stop();
            if (localPreview.current === track) localPreview.current = null;
            desired.current[kind] = false;
            if (kind === 'VIDEO') setCamOn(false);
            markOp(op, kind, 'failed');
            const code = errCode(e) === 'NOT_ALLOWED_TO_SPEAK' ? 'NOT_ALLOWED_TO_SPEAK' : null;
            const sentAhead = kind === 'AUDIO' && warmMic.current && !desired.current.AUDIO;
            if (kind === 'AUDIO') warmMic.current = false;
            if (!sentAhead) setNotice(code ?? (kind === 'VIDEO' ? 'CAM_FAILED' : 'MIC_FAILED'));
            bump();
            break;
          }
        }
      } finally {
        working.current[kind] = false;
        setPendingDevice((p) => ({ ...p, [kind]: false }));
        // A device another path changed (a revoke) keeps the switch truthful.
        if (kind === 'VIDEO') setCamOn(local.current.has('VIDEO'));
        else setMicOn(micAudible());
      }
    },
    [publish, unpublish, base, bump, applyMic],
  );
  convergeRef.current = converge;

  const toggleMic = useCallback(async () => {
    primeLessonAudio();
    const l = local.current.get('AUDIO');
    // What the switch shows now: the last press while the first send is under
    // way, otherwise the track itself.
    const now = working.current.AUDIO
      ? !!desired.current.AUDIO
      : !!l && l.track.readyState === 'live' && l.track.enabled;
    desired.current.AUDIO = !now;
    if (!now && micDeviceMutedRef.current) setNotice('MIC_DEVICE_MUTED');
    // Sent already: on or off at once. Not yet: opened and sent (once).
    if (applyMic()) return;
    if (working.current.AUDIO) setPendingDevice((p) => ({ ...p, AUDIO: !now }));
    await converge('AUDIO');
  }, [converge, applyMic]);

  // A microphone muted on the device (a laptop's mute key) sends exact digital
  // silence and no event: listened for, so the switch and the room follow it.
  useEffect(() => {
    if (!enabled || !joined) return;
    const judge = new DeviceMuteJudge();
    const buf = new Float32Array(1024);
    let cur: MediaStreamTrack | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let an: AnalyserNode | null = null;
    const h = setInterval(() => {
      const t = local.current.get('AUDIO')?.track ?? null;
      if (t !== cur) {
        src?.disconnect();
        src = null;
        an = null;
        cur = t;
        judge.reset();
        markMicDeviceMuted(false);
      }
      const ctx = lessonAudioContext();
      if (!t || t.readyState !== 'live' || !ctx) return;
      // Our own mute sends zeros too, and a suspended context reads zeros:
      // neither is the device's mute.
      if (!t.enabled || t.muted || ctx.state !== 'running') {
        judge.feed(null, Date.now());
        return;
      }
      if (!an) {
        try {
          src = ctx.createMediaStreamSource(new MediaStream([t]));
          an = ctx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
        } catch {
          return;
        }
      }
      an.getFloatTimeDomainData(buf);
      markMicDeviceMuted(judge.feed(peakOf(buf), Date.now()));
    }, 250);
    return () => {
      clearInterval(h);
      src?.disconnect();
    };
  }, [enabled, joined, markMicDeviceMuted]);

  const toggleCam = useCallback(async () => {
    const now = desired.current.VIDEO ?? local.current.has('VIDEO');
    desired.current.VIDEO = !now;
    await converge('VIDEO');
  }, [converge]);

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
    async (userId: string, action: 'approve' | 'reject' | 'revoke' | 'invite') => {
      try {
        await api.post(`/live/${liveSessionId}/hand/${userId}`, { action });
      } catch (e) {
        const code = errCode(e);
        setNotice(
          code === 'SPEAKER_LIMIT'
            ? 'SPEAKER_LIMIT'
            : code === 'MIC_BLOCKED'
              ? 'MIC_BLOCKED'
              : 'HAND_FAILED',
        );
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** A moderator: the class's microphone policy. */
  const setMicPolicy = useCallback(
    async (micPolicy: 'RAISE_HAND' | 'LISTEN_ONLY') => {
      try {
        await api.patch(`/teacher/live/${liveSessionId}/classroom`, { micPolicy });
      } catch {
        setNotice('POLICY_FAILED');
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** A moderator: bonus points for a student (throws, so the dialog can say why). */
  const grantBonus = useCallback(
    async (
      userId: string,
      b: { points: number; reasonKey?: string; reason?: string; requestId: string },
    ) => {
      await api.post(`/live/${liveSessionId}/bonus`, { studentUserId: userId, ...b });
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** A moderator: approve (a one-person capacity exception) or reject a request to join. */
  const decideAdmission = useCallback(
    async (requestId: string, decision: 'APPROVE' | 'REJECT') => {
      try {
        await api.post(`/teacher/live/${liveSessionId}/admissions/${requestId}`, { decision });
      } catch {
        setNotice('POLICY_FAILED');
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** A moderator: the class's camera policy. */
  const setCameraPolicy = useCallback(
    async (cameraPolicy: CameraPolicy) => {
      try {
        await api.patch(`/teacher/live/${liveSessionId}/classroom`, { cameraPolicy });
      } catch {
        setNotice('POLICY_FAILED');
      }
      await fetchState();
    },
    [liveSessionId, fetchState],
  );

  /** A moderator: remind a student to turn their camera on. */
  const nudgeCamera = useCallback(
    async (userId: string) => {
      await api
        .post(`${base}/participants/${userId}/nudge`)
        .catch(() => setNotice('POLICY_FAILED'));
    },
    [base],
  );

  /** A moderator's page: which page of students' cameras to pull. */
  const setCameraPage = useCallback(
    (page: number) => {
      cameraPageRef.current = Math.max(0, page);
      setCameraPageState(cameraPageRef.current);
      void reconcile().catch(() => undefined);
    },
    [reconcile],
  );

  /** A moderator: one participant's controls for this run. */
  const setControls = useCallback(
    async (
      userId: string,
      controls: { mic?: 'DEFAULT' | 'BLOCKED'; camera?: 'DEFAULT' | 'EXEMPT' | 'BLOCKED' },
    ) => {
      try {
        await api.put(`${base}/participants/${userId}/controls`, controls);
      } catch {
        setNotice('POLICY_FAILED');
      }
      await fetchState();
    },
    [base, fetchState],
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
        video: camOn && !camDeviceMuted,
        screen: sharing,
        track: local.current.get('VIDEO')?.track ?? localPreview.current ?? null,
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
    camOn: camOn && !camDeviceMuted,
    /** My microphone / camera muted or paused by the device itself (shown, not fought). */
    micDeviceMuted,
    camDeviceMuted,
    sharing,
    startPreview,
    join,
    leave,
    toggleMic,
    toggleCam,
    toggleShare,
    recording: !!state?.recording,
    /** The teacher's view: the recorder's real stage (recordingPhase.ts reads it). */
    recordingState: state?.recordingState ?? null,
    /** This tab's capture of the lesson's audio, and its counts. */
    capture: {
      status: captureStatus,
      heldElsewhere:
        captureStatus === 'elsewhere' ||
        (!!state?.captureLease && !state.captureLease.mine && !!state?.transcribing),
      ...captureStats,
    },
    /** A camera or microphone switch under way. */
    pendingDevice,
    /** Call from the teacher's click: lets the lesson's audio start there. */
    primeAudio: primeLessonAudio,
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
    /**
     * Read the room now — after the teacher's own change (recording started
     * or stopped), so this tab claims the capture at once instead of when the
     * socket or the poll gets round to telling it.
     */
    refreshState: () => void fetchState(),
    hands: (state?.participants ?? []).filter((p) => p.hand !== 'IDLE' && p.role === 'STUDENT'),
    raiseHand,
    lowerHand,
    decideHand,
    setMicPolicy,
    setControls,
    grantBonus,
    bonusReceived,
    setCameraPolicy,
    decideAdmission,
    nudgeCamera,
    nudged,
    cameraPage,
    setCameraPage,
    /** Students' cameras this moderator's page is not pulling (on other pages). */
    hiddenCameras: hiddenCamerasRef.current,
    /** The teacher invited me to speak (asked on the page, never switched on). */
    invited: invited && state?.me.hand === 'APPROVED_TO_SPEAK',
    audioBlocked,
    resumeAudio,
    connection,
  };
}

/** The browser already lets this site use the microphone (so opening it asks nothing). */
async function micPermissionGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' });
    return p?.state === 'granted';
  } catch {
    return false;
  }
}

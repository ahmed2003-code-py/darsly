import DailyIframe, { type DailyCall, type DailyParticipant } from '@daily-co/daily-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * The call object, and the bookkeeping around it.
 *
 * Daily's own state lives in an object that is not React's, so this keeps a
 * mirror the page can render from and subscribes to the events that change it.
 * Two things here are load-bearing beyond the obvious:
 *
 *  - Exactly one call object may exist per page. Daily refuses a second, and a
 *    StrictMode double-effect in development will try to make one, so creation
 *    is guarded by a ref rather than by effect identity.
 *  - The heartbeat is what attendance is counted from, so it runs on an
 *    interval rather than on Daily's events: a tab that froze stops sending,
 *    which is exactly the signal the server needs.
 */

/** Comfortably inside the server's presence grace period. */
const HEARTBEAT_MS = 30_000;

/**
 * Daily allows exactly one call object per page, and `destroy()` releases the
 * slot asynchronously. React's development double-mount therefore races itself:
 * the first cleanup is still tearing down when the second effect tries to
 * build. Holding the teardown promise here lets the next creation wait for it
 * instead of being refused — the alternative is a page that only works in
 * production, which is a page nobody can develop against.
 */
let teardown: Promise<unknown> | null = null;

export type Participant = {
  sessionId: string;
  userId: string | null;
  name: string;
  local: boolean;
  owner: boolean;
  audio: boolean;
  video: boolean;
  screen: boolean;
  track: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
};

function shape(p: DailyParticipant): Participant {
  return {
    sessionId: p.session_id,
    userId: p.user_id ?? null,
    name: p.user_name || '—',
    local: p.local,
    owner: !!p.owner,
    audio: !!p.audio,
    video: !!p.video,
    screen: !!p.screenVideoTrack,
    // Daily types these as `false` when absent, not undefined.
    track: p.videoTrack || null,
    screenTrack: p.screenVideoTrack || null,
  };
}

export function useDailyMeeting(liveSessionId: string) {
  const callRef = useRef<DailyCall | null>(null);
  const [call, setCall] = useState<DailyCall | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [recording, setRecording] = useState(false);
  const recIdResolve = useRef<((id: string | null) => void) | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  /** A short, self-clearing line for the things that fail quietly. */
  const [notice, setNotice] = useState<string | null>(null);

  // Built in an effect rather than during render, and only once the previous
  // page's teardown has finished.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (teardown) await teardown.catch(() => undefined);
      if (cancelled) return;
      const c =
        DailyIframe.getCallInstance() ??
        DailyIframe.createCallObject({
          // The page draws the tiles; Daily is the transport, not the interface.
          subscribeToTracksAutomatically: true,
        });
      callRef.current = c;
      setCall(c);
    })();
    return () => {
      cancelled = true;
      const c = callRef.current;
      callRef.current = null;
      setCall(null);
      if (c) {
        void api.post(`/live/${liveSessionId}/leave`).catch(() => undefined);
        // Recorded so the next mount waits rather than colliding.
        teardown = c
          .leave()
          .catch(() => undefined)
          .then(() => c.destroy())
          .catch(() => undefined)
          .finally(() => {
            teardown = null;
          });
      }
    };
  }, [liveSessionId]);

  useEffect(() => {
    const c = call;
    if (!c) return;
    const sync = () => {
      const all = Object.values(c.participants() ?? {}).map(shape);
      setParticipants(all);
      const me = all.find((p) => p.local);
      if (me) {
        setMicOn(me.audio);
        setCamOn(me.video);
        setSharing(me.screen);
      }
    };
    const onError = (e: any) => setError(e?.errorMsg ?? 'meeting');
    const events = [
      'participant-joined',
      'participant-updated',
      'participant-left',
      'joined-meeting',
      'track-started',
      'track-stopped',
    ] as const;
    events.forEach((e) => c.on(e as any, sync));
    c.on('error', onError);
    c.on('left-meeting', () => setJoined(false));
    // The provider's id for the recording arrives on the event, not from the
    // call that started it — so the promise `startRecording()` hands back is
    // settled here, where the id actually shows up.
    const onRecStarted = (ev: any) => {
      setRecording(true);
      recIdResolve.current?.(ev?.recordingId ?? null);
      recIdResolve.current = null;
    };
    const onRecStopped = () => setRecording(false);
    c.on('recording-started', onRecStarted);
    c.on('recording-stopped', onRecStopped);
    // Sync once on attach: a call object that already existed (the reused
    // instance) has participants this page has not heard the events for.
    sync();
    return () => {
      events.forEach((e) => c.off(e as any, sync));
      c.off('error', onError);
      c.off('recording-started', onRecStarted);
      c.off('recording-stopped', onRecStopped);
    };
  }, [call]);

  /** Camera preview before committing to the room. */
  const startPreview = useCallback(async () => {
    if (!call) return;
    try {
      await call.startCamera({ startVideoOff: false, startAudioOff: true });
      setCamOn(true);
    } catch {
      // Denied or absent hardware. The page says so; the meeting still works
      // without a camera, which is the point of not throwing here.
      setCamOn(false);
    }
  }, [call]);

  const join = useCallback(
    async (url: string, token: string, opts: { mic: boolean; cam: boolean }) => {
      setError(null);
      if (!call) return;
      await call.join({ url, token, startVideoOff: !opts.cam, startAudioOff: !opts.mic });
      setJoined(true);
    },
    [call],
  );

  const leave = useCallback(async () => {
    await api.post(`/live/${liveSessionId}/leave`).catch(() => undefined);
    await callRef.current?.leave().catch(() => undefined);
    setJoined(false);
  }, [liveSessionId]);

  const toggleMic = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    const next = !c.localAudio();
    c.setLocalAudio(next);
    setMicOn(next);
  }, []);

  const toggleCam = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    const next = !c.localVideo();
    c.setLocalVideo(next);
    setCamOn(next);
  }, []);

  /**
   * Whether this device can share a screen at all.
   *
   * Android has no `getDisplayMedia`: capturing the screen from a web page is
   * not a thing the platform offers, and most students are on a phone. Asked
   * once here so the page can say so, rather than showing a button that looks
   * alive and does nothing when pressed — which is what it did before.
   */
  const canShare =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const toggleShare = useCallback(async () => {
    const c = callRef.current;
    if (!c) return;
    if (!canShare) {
      setNotice('SHARE_UNSUPPORTED');
      return;
    }
    try {
      if (sharing) c.stopScreenShare();
      else await c.startScreenShare();
    } catch (e: any) {
      // Cancelling the picker is not a failure — it is the answer "no".
      const name = e?.name ?? '';
      if (name === 'NotAllowedError' || name === 'AbortError') return;
      setNotice('SHARE_FAILED');
    }
  }, [sharing, canShare]);

  /**
   * Recording, which only an owner token can start.
   *
   * Returns the provider's id so the caller can hand it to the server: without
   * it a finished recording cannot be found again.
   */
  const startRecording = useCallback(async (): Promise<string | null> => {
    const c = callRef.current;
    if (!c) return null;
    const waitForId = new Promise<string | null>((resolve) => {
      recIdResolve.current = resolve;
      // The recording is running either way; an id that never arrives should
      // not leave the caller waiting on it forever.
      setTimeout(() => {
        if (recIdResolve.current === resolve) {
          recIdResolve.current = null;
          resolve(null);
        }
      }, 8000);
    });
    try {
      await c.startRecording();
    } catch {
      recIdResolve.current = null;
      setNotice('RECORDING_FAILED');
      return null;
    }
    // Transcription rides along with the recording, because the teacher's
    // intent is the same one: capture this lesson. It is a separate feature at
    // the provider and may not be on every plan, so its failure is allowed to
    // be silent — the recording is still running, and the only thing lost is
    // the summary, which the session page reports on its own.
    try {
      await c.startTranscription();
      setTranscribing(true);
    } catch {
      setTranscribing(false);
    }
    return waitForId;
  }, []);

  const stopRecording = useCallback(async () => {
    const c = callRef.current;
    if (!c) return;
    try {
      await c.stopRecording();
    } catch {
      setNotice('RECORDING_FAILED');
    }
    try {
      await c.stopTranscription();
    } catch {
      // Never started, or already stopped. Neither is worth reporting.
    }
    setTranscribing(false);
    setRecording(false);
  }, []);

  /** Owner-only, and the server decided who that is. */
  const muteParticipant = useCallback((sessionId: string) => {
    callRef.current?.updateParticipant(sessionId, { setAudio: false });
  }, []);
  const removeParticipant = useCallback((sessionId: string) => {
    callRef.current?.updateParticipant(sessionId, { eject: true });
  }, []);

  // Presence. The interval is the record — see the service for why a browser's
  // own "I left" cannot be.
  useEffect(() => {
    if (!joined) return;
    const beat = () => void api.post(`/live/${liveSessionId}/heartbeat`).catch(() => undefined);
    beat();
    const h = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(h);
  }, [joined, liveSessionId]);

  // Notices are transient: a class is not the place for a message that has to
  // be dismissed before the video comes back.
  useEffect(() => {
    if (!notice) return;
    const h = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(h);
  }, [notice]);

  return {
    participants,
    joined,
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
    recording,
    transcribing,
    startRecording,
    stopRecording,
    muteParticipant,
    removeParticipant,
    ready: !!call,
  };
}

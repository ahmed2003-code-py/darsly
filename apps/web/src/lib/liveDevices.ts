import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The camera and microphone a teacher picked in the lobby — remembered on
 * this device only (a convenience, not state anyone else needs), and read by
 * the classroom when it opens the devices for real.
 */
const KEY = 'darsly-live-devices';

export interface DevicePrefs {
  cameraId?: string;
  micId?: string;
}

export function readDevicePrefs(): DevicePrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as DevicePrefs;
  } catch {
    return {};
  }
}

export function writeDevicePrefs(p: DevicePrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: the default device it is */
  }
}

/** A constraint for the remembered device, falling back to any device. */
export const videoConstraint = (extra: MediaTrackConstraints = {}): MediaTrackConstraints => {
  const id = readDevicePrefs().cameraId;
  return { ...extra, ...(id ? { deviceId: { ideal: id } } : {}) };
};
export const audioConstraint = (extra: MediaTrackConstraints = {}): MediaTrackConstraints => {
  const id = readDevicePrefs().micId;
  return { ...extra, ...(id ? { deviceId: { ideal: id } } : {}) };
};

/** Why a device could not be opened — each one says something different to the teacher. */
export type DeviceProblem = 'denied' | 'missing' | 'busy' | 'unsupported' | 'failed';

export function deviceProblem(e: unknown): DeviceProblem {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  if (name === 'TypeError') return 'unsupported';
  return 'failed';
}

export interface LobbyDevices {
  supported: boolean;
  checking: boolean;
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  prefs: DevicePrefs;
  camOn: boolean;
  micOn: boolean;
  preview: MediaStreamTrack | null;
  /** 0..1, for the level meter; null while the microphone is off. */
  level: number | null;
  camProblem: DeviceProblem | null;
  micProblem: DeviceProblem | null;
  setCamOn: (v: boolean) => void;
  setMicOn: (v: boolean) => void;
  choose: (p: DevicePrefs) => void;
  /** Stops everything the lobby opened — before the classroom opens its own. */
  release: () => void;
}

/**
 * The lobby's look at the teacher's devices: a camera preview, a live
 * microphone level, the lists to choose from, and a plain reason when a
 * device cannot be used. Only for someone who will send — a listening student
 * never reaches this, so the browser never asks them for anything.
 */
export function useLobbyDevices(enabled: boolean): LobbyDevices {
  const supported =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const [prefs, setPrefs] = useState<DevicePrefs>(readDevicePrefs);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [checking, setChecking] = useState(true);
  const [preview, setPreview] = useState<MediaStreamTrack | null>(null);
  const [level, setLevel] = useState<number | null>(null);
  const [camProblem, setCamProblem] = useState<DeviceProblem | null>(null);
  const [micProblem, setMicProblem] = useState<DeviceProblem | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const camRef = useRef<MediaStreamTrack | null>(null);
  const micRef = useRef<MediaStreamTrack | null>(null);
  const acRef = useRef<AudioContext | null>(null);

  const listDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setCameras(all.filter((d) => d.kind === 'videoinput' && d.deviceId));
      setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId));
    } catch {
      /* lists stay empty; the defaults still work */
    }
  }, []);

  // Camera preview.
  useEffect(() => {
    if (!enabled || !supported) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    camRef.current?.stop();
    camRef.current = null;
    setPreview(null);
    if (!camOn) {
      setChecking(false);
      return;
    }
    setChecking(true);
    navigator.mediaDevices
      .getUserMedia({ video: videoConstraint({ width: { ideal: 1280 }, height: { ideal: 720 } }) })
      .then((s) => {
        const t = s.getVideoTracks()[0];
        if (cancelled) return t.stop();
        camRef.current = t;
        setPreview(t);
        setCamProblem(null);
        t.addEventListener('ended', () => setCamProblem('missing'));
        void listDevices();
      })
      .catch((e) => !cancelled && setCamProblem(deviceProblem(e)))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
  }, [enabled, supported, camOn, prefs.cameraId, listDevices]);

  // Microphone level.
  useEffect(() => {
    if (!enabled || !supported || !micOn) {
      micRef.current?.stop();
      micRef.current = null;
      setLevel(null);
      return;
    }
    let cancelled = false;
    let raf = 0;
    micRef.current?.stop();
    navigator.mediaDevices
      .getUserMedia({ audio: audioConstraint({ echoCancellation: true }) })
      .then((s) => {
        const t = s.getAudioTracks()[0];
        if (cancelled) return t.stop();
        micRef.current = t;
        setMicProblem(null);
        void listDevices();
        const ac = acRef.current ?? new AudioContext();
        acRef.current = ac;
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(new MediaStream([t])).connect(an);
        const buf = new Uint8Array(an.fftSize);
        let last = 0;
        const read = (now: number) => {
          // A meter, not an animation: ~8 updates a second is plenty.
          if (now - last > 120) {
            last = now;
            an.getByteTimeDomainData(buf);
            let peak = 0;
            for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
            setLevel(Math.min(1, peak / 64));
          }
          raf = requestAnimationFrame(read);
        };
        raf = requestAnimationFrame(read);
      })
      .catch((e) => !cancelled && setMicProblem(deviceProblem(e)));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [enabled, supported, micOn, prefs.micId, listDevices]);

  const release = useCallback(() => {
    camRef.current?.stop();
    micRef.current?.stop();
    camRef.current = null;
    micRef.current = null;
    void acRef.current?.close().catch(() => undefined);
    acRef.current = null;
    setPreview(null);
  }, []);

  useEffect(() => release, [release]);

  const choose = useCallback((p: DevicePrefs) => {
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      writeDevicePrefs(next);
      return next;
    });
  }, []);

  return {
    supported,
    checking,
    cameras,
    mics,
    prefs,
    camOn,
    micOn,
    preview,
    level,
    camProblem: supported ? camProblem : 'unsupported',
    micProblem: supported ? micProblem : 'unsupported',
    setCamOn,
    setMicOn,
    choose,
    release,
  };
}

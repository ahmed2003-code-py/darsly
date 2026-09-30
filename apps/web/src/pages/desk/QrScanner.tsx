import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The camera, reading QR codes — loaded only when the desk opens it.
 *
 * Frames stay in this browser tab: each one is decoded here (the browser's
 * own BarcodeDetector where it exists — Android Chrome, recent Safari — else
 * jsQR, loaded on demand) and then dropped. Nothing is uploaded, stored or
 * sent anywhere; only the decoded text reaches the desk, which posts it in a
 * request body.
 *
 * `continuous` (Rush mode) keeps scanning after a read; the same code is
 * ignored for a moment so one card held up does not fire ten times.
 */

type CamError = 'denied' | 'none' | 'busy' | 'unsupported';

interface Detector {
  detect(src: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

const SAME_CODE_PAUSE_MS = 2500;
const FRAME_EVERY_MS = 120;

export default function QrScanner({
  onCode,
  onClose,
  continuous = false,
  children,
}: {
  onCode: (text: string) => void;
  onClose: () => void;
  continuous?: boolean;
  /** Shown over the camera — the last result, in Rush mode. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<CamError | null>(null);
  const [ready, setReady] = useState(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    let last = { text: '', at: 0 };
    const canvas = document.createElement('canvas');
    const c2d = canvas.getContext('2d', { willReadFrequently: true });

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('unsupported');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'denied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'none'
              : name === 'NotReadableError' || name === 'AbortError'
                ? 'busy'
                : 'unsupported',
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      setReady(true);

      // The browser's own detector when it reads QR; otherwise jsQR.
      let detector: Detector | null = null;
      const BD = (
        window as unknown as {
          BarcodeDetector?: {
            new (o: { formats: string[] }): Detector;
            getSupportedFormats(): Promise<string[]>;
          };
        }
      ).BarcodeDetector;
      if (BD) {
        try {
          const formats = await BD.getSupportedFormats();
          if (formats.includes('qr_code')) detector = new BD({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }
      const jsQR = detector ? null : (await import('jsqr')).default;

      const tick = async () => {
        if (stopped) return;
        let text: string | null = null;
        try {
          if (v.readyState >= 2 && v.videoWidth) {
            if (detector) {
              const found = await detector.detect(v);
              text = found[0]?.rawValue ?? null;
            } else if (jsQR && c2d) {
              // Downscaled: enough for a card held up to the camera, and cheap.
              const scale = Math.min(1, 640 / v.videoWidth);
              canvas.width = Math.round(v.videoWidth * scale);
              canvas.height = Math.round(v.videoHeight * scale);
              c2d.drawImage(v, 0, 0, canvas.width, canvas.height);
              const img = c2d.getImageData(0, 0, canvas.width, canvas.height);
              text =
                jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ??
                null;
            }
          }
        } catch {
          text = null;
        }
        if (text && !(text === last.text && Date.now() - last.at < SAME_CODE_PAUSE_MS)) {
          last = { text, at: Date.now() };
          navigator.vibrate?.(40);
          onCodeRef.current(text);
          if (!continuous) return;
        }
        timer = window.setTimeout(() => void tick(), FRAME_EVERY_MS);
      };
      void tick();
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
      canvas.width = canvas.height = 0;
    };
  }, [continuous]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('desk.scan.title')}
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="font-bold">{t('desk.scan.title')}</p>
        <button
          type="button"
          onClick={onClose}
          className="grid h-11 w-11 place-items-center rounded-full bg-white/15 hover:bg-white/25"
          aria-label={t('common.close')}
          autoFocus
        >
          <span className="material-symbols-outlined" aria-hidden>
            close
          </span>
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={video}
          className="absolute inset-0 h-full w-full object-cover"
          playsInline
          muted
          aria-hidden
        />
        {!error && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="aspect-square w-[min(70vw,18rem)] rounded-3xl border-4 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.35)]" />
          </div>
        )}
        {error ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-xs">
              <span className="material-symbols-outlined mb-2 text-5xl" aria-hidden>
                no_photography
              </span>
              <p className="mb-1 text-lg font-bold">{t(`desk.scan.err.${error}.title`)}</p>
              <p className="mb-4 text-sm text-white/80">{t(`desk.scan.err.${error}.hint`)}</p>
              <button type="button" className="btn-primary min-h-11 px-5" onClick={onClose}>
                {t('desk.scan.useKeyboard')}
              </button>
            </div>
          </div>
        ) : (
          !ready && (
            <p className="absolute inset-x-0 top-6 text-center text-sm text-white/80" role="status">
              {t('desk.scan.starting')}
            </p>
          )
        )}
      </div>
      <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {children ??
          (!error && <p className="text-center text-sm text-white/80">{t('desk.scan.hint')}</p>)}
      </div>
    </div>
  );
}

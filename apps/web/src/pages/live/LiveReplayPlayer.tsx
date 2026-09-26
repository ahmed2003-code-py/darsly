import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WatermarkPayload } from '@darsly/shared-types';
import RovingWatermark from '../../components/RovingWatermark';
import { api, apiOrigin } from '../../lib/api';

interface ReplayTicket {
  replaySessionId: string;
  masterUrl: string;
  durationSec: number;
  expiresAt: string;
  watermark: { name: string; watermarkId: string };
}

/**
 * A live lesson's recording, played inside Darsly.
 *
 * The same protection as a course lesson: encrypted HLS over a signed,
 * expiring URL bound to one replay session, the key released only while that
 * session is open and the viewer is still allowed, and the viewer's name on
 * the picture. Nothing here is a file URL — there is none to copy.
 *
 * A replay session is opened when the viewer presses play (not when the page
 * is opened), and closed when the player goes away.
 */
export default function LiveReplayPlayer({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const replayId = useRef<string | null>(null);
  const [ticket, setTicket] = useState<ReplayTicket | null>(null);
  const [error, setError] = useState(false);
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [level, setLevel] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    api
      .post<ReplayTicket>(`/live/${sessionId}/replay`)
      .then(({ data }) => {
        if (cancelled) {
          void api.post(`/live/${sessionId}/replay/${data.replaySessionId}/end`).catch(() => undefined);
          return;
        }
        replayId.current = data.replaySessionId;
        setTicket(data);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
      hls.current?.destroy();
      hls.current = null;
      if (replayId.current) {
        void api.post(`/live/${sessionId}/replay/${replayId.current}/end`).catch(() => undefined);
        replayId.current = null;
      }
    };
  }, [sessionId]);

  useEffect(() => {
    const v = video.current;
    if (!ticket || !v || hls.current) return;
    const url = `${apiOrigin()}${ticket.masterUrl}`;
    if (Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 30 });
      h.loadSource(url);
      h.attachMedia(v);
      h.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(
          h.levels
            .map((l, index) => ({ index, height: l.height || 0 }))
            .filter((l) => l.height)
            .sort((a, b) => b.height - a.height),
        );
        void v.play().catch(() => undefined);
      });
      h.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) setError(true);
      });
      hls.current = h;
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; // Safari plays HLS itself
      void v.play().catch(() => undefined);
    } else {
      setError(true);
    }
  }, [ticket]);

  const pick = (i: number) => {
    setLevel(i);
    if (hls.current) hls.current.currentLevel = i;
  };

  if (error) {
    return (
      <p className="rounded-xl bg-error-container/40 px-3 py-2 text-sm text-on-error-container" role="alert">
        {t('record.rec.playerError')}
      </p>
    );
  }
  const wm: WatermarkPayload | null = ticket
    ? {
        studentId: '',
        studentName: ticket.watermark.name,
        studentPhone: '',
        watermarkId: ticket.watermark.watermarkId,
        sessionId: ticket.replaySessionId,
        issuedAt: new Date().toISOString(),
      }
    : null;

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-xl bg-black" onContextMenu={(e) => e.preventDefault()}>
        <video
          ref={video}
          controls
          playsInline
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          className="aspect-video w-full bg-black"
          aria-label={t('summary.recording')}
        />
        {!ticket && (
          <div className="absolute inset-0 grid place-items-center text-sm text-zinc-300" role="status">
            {t('record.rec.loadingPlayer')}
          </div>
        )}
        {wm && <RovingWatermark payload={wm} />}
      </div>
      {levels.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-outline">
          {t('record.rec.quality')}
          <select
            className="rounded-lg border border-outline-variant bg-surface px-2 py-1 text-xs"
            value={level}
            onChange={(e) => pick(Number(e.target.value))}
          >
            <option value={-1}>{t('record.rec.auto')}</option>
            {levels.map((l) => (
              <option key={l.index} value={l.index}>
                {l.height}p
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

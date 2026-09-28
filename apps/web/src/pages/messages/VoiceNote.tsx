import { useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../../lib/api';
import { clock } from './format';

/**
 * A voice note, played in place.
 *
 * Two sources. A voice note sent with a message is an attachment with a
 * signed, short-lived link — the browser can play that directly. An older
 * voice note (sent through the retired voice endpoint) is private behind the
 * bearer token, so it is fetched once on the first press and kept as an
 * object URL for the rest of the visit.
 *
 * The length shown is the recorder's: a browser's own recording often has no
 * duration in its header until it has been played through.
 */
export default function VoiceNote({
  src,
  messageId,
  seconds,
  mine,
  t,
}: {
  /** A signed link (a voice attachment) or a local object URL (a draft). */
  src?: string | null;
  /** A legacy voice message, fetched through the API. */
  messageId?: string;
  seconds: number;
  mine: boolean;
  t: (k: string, o?: any) => string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  async function toggle() {
    if (audioRef.current) {
      if (playing) audioRef.current.pause();
      else audioRef.current.play().catch(() => setFailed(true));
      return;
    }
    try {
      let url = src ? (src.startsWith('blob:') ? src : mediaUrl(src)!) : null;
      if (!url && messageId) {
        const { data } = await api.get(`/chat/messages/${messageId}/voice`, {
          responseType: 'blob',
        });
        url = URL.createObjectURL(data);
        setObjectUrl(url);
      }
      if (!url) return;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onplay = () => setPlaying(true);
      audio.onpause = () => setPlaying(false);
      audio.onended = () => {
        setPlaying(false);
        setAt(0);
      };
      audio.ontimeupdate = () => setAt(audio.currentTime);
      audio.onerror = () => setFailed(true);
      await audio.play();
    } catch {
      setFailed(true);
    }
  }

  const pct = seconds > 0 ? Math.min(100, (at / seconds) * 100) : 0;
  return (
    <span className="flex w-[13.5rem] max-w-full items-center gap-2.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('messages.pause') : t('messages.playVoice')}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
          mine ? 'bg-black/15 text-on-primary' : 'bg-primary-fixed text-on-primary-fixed'
        }`}
      >
        <span className="material-symbols-outlined text-[22px]">
          {failed ? 'error' : playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`h-1.5 overflow-hidden rounded-full ${mine ? 'bg-black/20' : 'bg-surface-container-highest'}`}
        >
          <span
            className={`block h-full rounded-full transition-[width] ${mine ? 'bg-on-primary/80' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span
          className={`flex items-center gap-1 text-[11px] ${mine ? 'text-on-primary/75' : 'text-on-surface-variant'}`}
        >
          <span className="material-symbols-outlined text-[13px]" aria-hidden>
            mic
          </span>
          <span dir="ltr">
            {failed ? t('messages.playbackFailed') : clock(playing || at > 0 ? at : seconds)}
          </span>
        </span>
      </span>
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { clock } from './format';

/**
 * A voice note, played in place.
 *
 * The audio is private, so it cannot be an `<audio src>` the browser fetches on
 * its own — there is no way to attach the bearer token to that request. It is
 * fetched once, on the first press, and kept as an object URL for the rest of
 * the visit.
 */
export default function VoiceNote({
  id,
  seconds,
  mine,
  t,
}: {
  id: string;
  seconds: number;
  mine: boolean;
  t: (k: string, o?: any) => string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  async function toggle() {
    if (audioRef.current) {
      if (playing) audioRef.current.pause();
      else audioRef.current.play().catch(() => setFailed(true));
      return;
    }
    try {
      const { data } = await api.get(`/chat/messages/${id}/voice`, { responseType: 'blob' });
      const objectUrl = URL.createObjectURL(data);
      setUrl(objectUrl);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.onplay = () => setPlaying(true);
      audio.onpause = () => setPlaying(false);
      audio.onended = () => {
        setPlaying(false);
        setAt(0);
      };
      audio.ontimeupdate = () => setAt(audio.currentTime);
      await audio.play();
    } catch {
      setFailed(true);
    }
  }

  const pct = seconds > 0 ? Math.min(100, (at / seconds) * 100) : 0;
  return (
    <span className="flex items-center gap-2.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('messages.pause') : t('messages.playVoice')}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition ${
          mine ? 'bg-black/15 text-on-primary' : 'bg-primary-fixed text-on-primary-fixed'
        }`}
      >
        <span className="material-symbols-outlined text-[22px]">
          {failed ? 'error' : playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <span className="flex min-w-[8rem] flex-1 flex-col gap-1">
        <span
          className={`h-1.5 overflow-hidden rounded-full ${mine ? 'bg-black/20' : 'bg-surface-container-highest'}`}
        >
          <span
            className={`block h-full rounded-full transition-[width] ${mine ? 'bg-on-primary/80' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span
          className={`text-[11px] ${mine ? 'text-on-primary/75' : 'text-on-surface-variant'}`}
          dir="ltr"
        >
          {failed ? t('messages.playbackFailed') : clock(playing || at > 0 ? at : seconds)}
        </span>
      </span>
    </span>
  );
}

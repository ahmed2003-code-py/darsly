import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Participant } from '../../../lib/useDailyMeeting';

/**
 * The media pieces of the classroom. Memoised on the track, so a chat message,
 * a clock tick or a hand going up re-renders the page around them without
 * touching a <video> element (re-attaching a stream is what makes video blink).
 */

/** Paints one track onto a real <video>, letterboxed — never stretched or cropped. */
export const Video = memo(function Video({
  track,
  muted,
  mirror,
  fit = 'contain',
}: {
  track: MediaStreamTrack | null;
  muted?: boolean;
  mirror?: boolean;
  fit?: 'contain' | 'cover';
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!track) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([track]);
    // Autoplay can be refused; nothing useful to do but not crash the class.
    void el.play().catch(() => undefined);
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${mirror ? '-scale-x-100' : ''}`}
    />
  );
});

export function Initial({ name, size = 'lg' }: { name: string; size?: 'sm' | 'lg' }) {
  return (
    <div className="grid h-full w-full place-items-center">
      <span
        aria-hidden
        className={`grid place-items-center rounded-full bg-zinc-700 font-heading font-bold text-zinc-100 ${
          size === 'lg' ? 'h-20 w-20 text-3xl' : 'h-10 w-10 text-base'
        }`}
      >
        {name.trim().charAt(0) || '؟'}
      </span>
    </div>
  );
}

/** A name label with the states that matter at a glance: muted, teacher, pinned. */
export function NameTag({
  p,
  isTeacher,
  pinned,
  compact,
}: {
  p: Participant;
  isTeacher: boolean;
  pinned?: boolean;
  /** Small tiles: the name only, on one line. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1 text-xs font-semibold text-white">
      {!p.audio && (
        <span className="material-symbols-outlined text-[15px] text-red-300" aria-label={t('meeting.micOff')}>
          mic_off
        </span>
      )}
      <span className="truncate">{p.local ? t('meeting.you') : p.name}</span>
      {isTeacher && !compact && (
        <span className="shrink-0 text-[10px] font-bold text-zinc-300">· {t('meeting.teacherBadge')}</span>
      )}
      {pinned && (
        <span className="material-symbols-outlined text-[14px]" aria-label={t('meeting.pinned')}>
          keep
        </span>
      )}
    </span>
  );
}

/**
 * One participant. Clicking pins them to the stage — on this screen only;
 * nobody else's view changes.
 */
export const Tile = memo(function Tile({
  p,
  isTeacher,
  pinned,
  onPin,
  compact,
}: {
  p: Participant;
  isTeacher: boolean;
  pinned: boolean;
  onPin?: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const Wrapper = onPin ? 'button' : 'div';
  return (
    <Wrapper
      {...(onPin
        ? {
            type: 'button' as const,
            onClick: () => onPin(p.sessionId),
            'aria-pressed': pinned,
            'aria-label': `${p.local ? t('meeting.you') : p.name} — ${pinned ? t('meeting.unpin') : t('meeting.pin')}`,
          }
        : {})}
      className={`group relative block aspect-video w-full overflow-hidden rounded-xl bg-zinc-800 text-start outline-none ring-offset-2 ring-offset-zinc-950 focus-visible:ring-2 focus-visible:ring-primary ${
        pinned ? 'ring-2 ring-primary' : ''
      }`}
    >
      {p.video && p.track ? (
        <Video track={p.track} muted={p.local} mirror={p.local} fit="cover" />
      ) : (
        <Initial name={p.name} size={compact ? 'sm' : 'lg'} />
      )}
      <span className="absolute bottom-1.5 start-1.5 end-1.5 flex">
        <NameTag p={p} isTeacher={isTeacher} pinned={pinned} compact={compact} />
      </span>
    </Wrapper>
  );
}, sameTile);

/**
 * Participants are rebuilt on every render of the meeting hook, so identity
 * says nothing; what is drawn is.
 */
function sameTile(
  a: { p: Participant; isTeacher: boolean; pinned: boolean; compact?: boolean; onPin?: unknown },
  b: typeof a,
) {
  return (
    a.p.sessionId === b.p.sessionId &&
    a.p.name === b.p.name &&
    a.p.audio === b.p.audio &&
    a.p.video === b.p.video &&
    a.p.track === b.p.track &&
    a.p.local === b.p.local &&
    a.isTeacher === b.isTeacher &&
    a.pinned === b.pinned &&
    a.compact === b.compact &&
    a.onPin === b.onPin
  );
}

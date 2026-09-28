import { useState } from 'react';
import { avatarTone, initials } from '../lib/initials';
import { mediaUrl } from '../lib/api';

/**
 * A person's avatar: their picture when it loads, otherwise clean initials on
 * a colour that is stable per person. Never a broken-image icon — a picture
 * that fails to load falls back to the initials instead.
 *
 * Sized inline rather than by class: Tailwind only ships classes it can see in
 * the source, and a computed size is not one of them.
 */
const TONES = [
  'bg-primary-fixed text-on-primary-fixed',
  'bg-student-accent-soft text-student-accent-ink',
  'bg-student-secondary-soft text-student-secondary-ink',
  'bg-student-gold-soft text-student-gold-ink',
] as const;

export default function Avatar({
  id,
  name,
  url,
  size = 40,
  className = '',
}: {
  id?: string | null;
  name: string;
  url?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const letters = initials(name);
  const src = mediaUrl(url);
  const showImage = !!src && !failed;
  return (
    <span
      aria-hidden
      className={`grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-heading font-bold ${
        showImage ? 'bg-surface-container-high' : TONES[avatarTone(id ?? name)]
      } ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(11, Math.round(size * (letters.length > 1 ? 0.36 : 0.44))),
      }}
    >
      {showImage ? (
        <img
          src={src!}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <bdi>{letters}</bdi>
      )}
    </span>
  );
}

import type { AdminThemeEntry } from '@darsly/shared-types';

/**
 * A theme in miniature — the one card drawing every picker on the platform
 * uses: the student's Studio, the Admin Studio, the looks a Center is granted,
 * and the Center's own Studio.
 *
 * It used to be three drawings. The student's card painted the theme's own
 * colours; the admin's painted console tokens re-derived by a different
 * engine, so the same theme had a different ground, panel and accent
 * depending on who was looking. One component, fed one shape (`ThemeSwatch`,
 * resolved by the server), means an admin granting a look sees the look a
 * student buys.
 */
export function ThemeMiniature({
  accent,
  accentDark,
  gold,
  surfaces,
  pattern,
  tall,
  sheen,
}: {
  accent: string;
  accentDark?: string | null;
  gold?: string | null;
  surfaces?: { background?: string; surface?: string; ink?: string } | null;
  pattern?: string | null;
  tall?: boolean;
  sheen?: boolean;
}) {
  const ground = surfaces?.background ?? null;
  const panel = surfaces?.surface ?? null;
  const ink = surfaces?.ink ?? null;
  const value = gold ?? accentDark ?? accent;
  // Without a ground of its own the mini sits on the page's, so the accent is
  // shown doing the only job it actually does.
  const bg = ground
    ? `linear-gradient(160deg, ${ground} 0%, ${panel ?? ground} 100%)`
    : `linear-gradient(135deg, ${accent}, ${accentDark ?? accent})`;

  return (
    <span
      aria-hidden="true"
      className={`relative block w-full overflow-hidden rounded-xl ${
        tall ? 'h-36 sm:h-44' : 'h-24'
      } ${sheen ? 'studio-sheen' : ''}`}
      style={{ background: bg }}
    >
      {/* The theme's own pattern, at the weight it is worn. */}
      {pattern === 'stadium' && ground && (
        <span
          className="absolute inset-0"
          style={{
            backgroundImage: [
              `radial-gradient(120% 70% at 50% -20%, ${value}22 0%, transparent 60%)`,
              `linear-gradient(to right, ${ink ?? '#fff'}14 1px, transparent 1px)`,
              `linear-gradient(to bottom, ${ink ?? '#fff'}0d 1px, transparent 1px)`,
            ].join(','),
            backgroundSize: '100% 100%, 28px 100%, 100% 28px',
          }}
        />
      )}

      <span className="absolute inset-0 flex flex-col gap-1.5 p-2.5">
        {/* The bar: a mark and two rows, the shapes anyone recognises as an app. */}
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-md" style={{ background: accent }} />
          <span
            className="h-1.5 w-8 rounded-full"
            style={{ background: ink ?? '#ffffff', opacity: 0.5 }}
          />
          <span
            className="ms-auto h-3 w-7 rounded-full"
            style={{ background: value, opacity: 0.9 }}
          />
        </span>

        {/* The card: where everything in this product is read. */}
        <span
          className="mt-auto flex flex-col gap-1.5 rounded-lg p-2"
          style={{
            background: panel ?? ground ?? '#ffffff',
            border: `1px solid ${ink ?? '#ffffff'}1f`,
          }}
        >
          <span
            className="h-1.5 w-2/3 rounded-full"
            style={{ background: ink ?? '#101010', opacity: 0.85 }}
          />
          <span
            className="h-1.5 w-1/3 rounded-full"
            style={{ background: ink ?? '#101010', opacity: 0.4 }}
          />
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="h-3.5 w-12 rounded-md" style={{ background: accent }} />
            <span className="h-3.5 w-8 rounded-md" style={{ background: value, opacity: 0.85 }} />
          </span>
        </span>
      </span>
    </span>
  );
}

/** A catalogue entry's card, exactly as the student's Studio would draw it. */
export function EntryMiniature({ entry, tall }: { entry: AdminThemeEntry; tall?: boolean }) {
  const s = entry.swatch;
  return (
    <ThemeMiniature
      accent={s.accent}
      accentDark={s.accentDark}
      gold={s.gold}
      surfaces={s.surfaces}
      pattern={s.pattern}
      tall={tall}
      sheen={entry.meta.rarity === 'LEGENDARY'}
    />
  );
}

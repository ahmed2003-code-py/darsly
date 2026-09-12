import { useTranslation } from 'react-i18next';
import { AchievementRow, useLocalized } from '../../lib/gamification';
import { Stagger, StaggerItem } from '../motion';

/**
 * Every achievement, earned and not.
 *
 * Locked ones are shown with their progress rather than hidden, because "7 of
 * 10 lessons" is the part that actually pulls someone back — a wall of
 * mysteries is just a wall.
 */
export function AchievementGrid({ rows, limit }: { rows: AchievementRow[]; limit?: number }) {
  const { t } = useTranslation();
  const L = useLocalized();

  // Earned first, then whatever the student is closest to finishing.
  const sorted = [...rows].sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    return b.progress / b.threshold - a.progress / a.threshold;
  });
  const shown = limit ? sorted.slice(0, limit) : sorted;

  return (
    <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {shown.map((a) => {
        const pct = Math.min(100, Math.round((a.progress / Math.max(1, a.threshold)) * 100));
        return (
          <StaggerItem key={a.key}>
            <div
              title={L({ ar: a.descAr, en: a.descEn })}
              className={`flex h-full flex-col items-center gap-1.5 rounded-xl border p-4 text-center transition ${
                a.earned
                  ? 'border-accent-300 bg-primary-fixed/50'
                  : 'border-outline-variant bg-surface-container-low'
              }`}
            >
              <span
                className={`grid h-12 w-12 place-items-center rounded-full ${
                  a.earned ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-outline'
                }`}
              >
                <span
                  className="material-symbols-outlined"
                  style={a.earned ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  {a.earned ? a.icon : 'lock'}
                </span>
              </span>

              <span className={`text-sm font-semibold ${a.earned ? '' : 'text-on-surface-variant'}`}>
                {L({ ar: a.titleAr, en: a.titleEn })}
              </span>

              {a.earned ? (
                <span className="text-[10px] font-bold uppercase tracking-wide text-primary">
                  {t('gamification.achievements.unlocked')}
                </span>
              ) : (
                <span className="mt-auto w-full">
                  {a.threshold > 1 && (
                    <>
                      <span className="mb-1 block font-mono text-xs text-outline">
                        {a.progress}/{a.threshold}
                      </span>
                      <span className="block h-1 w-full overflow-hidden rounded-full bg-surface-container-high">
                        <span className="block h-full rounded-full bg-outline-variant" style={{ width: `${pct}%` }} />
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
          </StaggerItem>
        );
      })}
    </Stagger>
  );
}

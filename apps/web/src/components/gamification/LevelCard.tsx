import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { compactNum, GamificationSnapshot, useLocalized } from '../../lib/gamification';

/**
 * The one block that answers "how am I doing?" — level, progress to the next
 * one, streak, rank and coins. It is the top of the dashboard and the top of
 * the learning centre, so it is written once and used in both.
 */
export function LevelCard({ g, compact }: { g: GamificationSnapshot; compact?: boolean }) {
  const { t } = useTranslation();
  const L = useLocalized();
  const levelName = L({ ar: g.level.nameAr, en: g.level.nameEn });

  return (
    <div className="card">
      <div className="flex items-center gap-4">
        <span className="relative grid h-16 w-16 shrink-0 place-items-center rounded-full bg-student-gold-soft">
          <span
            className="material-symbols-outlined text-[30px] text-student-gold-ink"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            {g.level.icon}
          </span>
          <span className="absolute -bottom-1 grid h-6 min-w-6 place-items-center rounded-full border-2 border-surface-container-lowest bg-primary px-1 font-heading text-xs font-extrabold text-on-primary">
            {g.level.level}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-lg font-extrabold leading-tight">{levelName}</p>
          <p className="text-sm text-on-surface-variant">
            {compactNum(g.xp)} {t('gamification.xp')}
            {g.activeTitle && <span className="text-student-gold-ink"> · {g.activeTitle}</span>}
          </p>
        </div>
        {!compact && (
          <Link to="/learning" className="btn-ghost hidden py-2 text-sm sm:inline-flex">
            {t('gamification.cta.open')}
          </Link>
        )}
      </div>

      {/* Progress to the next level. At the top tier the bar reads full rather
          than pretending there is more to climb. */}
      <div className="mt-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div
            className="h-full rounded-full bg-student-gold transition-[width] duration-500 ease-premium"
            style={{ width: `${g.level.pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-outline">
          {g.level.nextLevel
            ? t('gamification.xpToNext', { count: g.level.xpForNext })
            : t('gamification.maxLevel')}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-outline-variant/50 pt-4 text-center">
        <Stat
          icon="local_fire_department"
          value={g.streak.current}
          label={t('gamification.streak')}
          tone="streak"
        />
        <Stat
          icon="leaderboard"
          value={`#${g.rank.weekly}`}
          label={t('gamification.rank')}
          tone="gold"
        />
        <Stat icon="toll" value={compactNum(g.coins)} label={t('gamification.coins')} tone="gold" />
      </div>
    </div>
  );
}

/**
 * Gold means earned; the streak is not.
 *
 * Coins and rank are winnings — they belong to the platform's one "earned"
 * colour, which is what makes a medal read as a medal on any theme. A streak is
 * a habit: it is not spent, not ranked and not won, and painting it gold put
 * three golds in a row and made the whole card one colour. It takes the theme's
 * second colour instead — which until now nothing on any screen used, so a
 * theme that named two colours only ever showed one.
 */
const TONES: Record<string, string> = {
  gold: 'text-student-gold-ink',
  streak: 'text-student-secondary-ink',
};

function Stat({
  icon,
  value,
  label,
  tone,
}: {
  icon: string;
  value: string | number;
  label: string;
  tone?: 'gold' | 'streak';
}) {
  return (
    <div>
      <span
        className={`material-symbols-outlined text-[20px] ${(tone && TONES[tone]) ?? 'text-primary'}`}
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        {icon}
      </span>
      <p className="font-heading text-lg font-extrabold leading-none">{value}</p>
      <p className="mt-0.5 text-[11px] text-outline">{label}</p>
    </div>
  );
}

/**
 * The streak warning.
 *
 * Shown only when there is a real streak and nothing has counted toward it
 * today — never as a permanent nag, and never invented to create urgency where
 * none exists.
 */
export function StreakAtRisk({ g }: { g: GamificationSnapshot }) {
  const { t } = useTranslation();
  if (!g.streak.atRisk) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-student-secondary/25 bg-student-secondary-soft px-4 py-3 text-sm text-student-secondary-ink">
      <span
        className="material-symbols-outlined text-[22px]"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        local_fire_department
      </span>
      <span className="flex-1 font-semibold">{t('gamification.streakAtRisk')}</span>
      {g.streak.freezes > 0 && (
        <span className="hidden shrink-0 rounded-full bg-student-secondary-soft px-2.5 py-1 text-xs font-bold sm:block">
          {t('gamification.streakFreezes', { count: g.streak.freezes })}
        </span>
      )}
    </div>
  );
}

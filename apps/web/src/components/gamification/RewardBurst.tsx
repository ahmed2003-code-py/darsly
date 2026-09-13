import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GamificationOutcome, useLocalized } from '../../lib/gamification';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The moment something was earned.
 *
 * Deliberately not a modal. A student who just finished a lesson wants the next
 * lesson, not a dialog to dismiss first — so this floats above the page, says
 * what happened, and leaves on its own. Everything it reports is something the
 * server actually awarded; there is no animation here for an event that paid
 * nothing.
 */
export function RewardBurst({
  outcome,
  onDone,
}: {
  outcome: GamificationOutcome | null;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const L = useLocalized();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!outcome?.awarded) return;
    setOpen(true);
    // Long enough to read a level-up, short enough not to sit on the screen.
    const ms = outcome.leveledUp || outcome.achievements.length ? 7000 : 4500;
    const timer = setTimeout(() => {
      setOpen(false);
      onDone?.();
    }, ms);
    return () => clearTimeout(timer);
  }, [outcome, onDone]);

  if (!outcome?.awarded) return null;

  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-4 lg:bottom-6 lg:inset-x-auto lg:end-6 lg:justify-end"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
          transition={{ duration: 0.28, ease: EASE }}
        >
          <div className="pointer-events-auto w-full max-w-sm rounded-3xl border border-outline-variant bg-surface-container-lowest p-4 shadow-modal">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-student-gold-soft text-student-gold-ink">
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>
                  {outcome.leveledUp ? 'trending_up' : 'bolt'}
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-heading font-extrabold leading-tight">
                  {outcome.leveledUp
                    ? t('gamification.celebrate.levelUp', { n: outcome.level })
                    : t('gamification.celebrate.lessonDone')}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {outcome.xp > 0 && (
                    <span className="font-bold text-student-gold-ink">+{outcome.xp} {t('gamification.xp')}</span>
                  )}
                  {outcome.coins > 0 && (
                    <span className="font-bold text-student-gold-ink">+{outcome.coins} {t('gamification.coins')}</span>
                  )}
                </p>
                {outcome.leveledUp && (
                  <p className="mt-1 text-xs text-on-surface-variant">
                    {t('gamification.celebrate.levelUpBody', {
                      name: L({ ar: outcome.levelNameAr, en: outcome.levelNameEn }),
                    })}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label="close"
                onClick={() => { setOpen(false); onDone?.(); }}
                className="shrink-0 text-outline transition hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {(outcome.achievements.length > 0 || outcome.missions.length > 0) && (
              <div className="mt-3 space-y-1.5 border-t border-outline-variant/50 pt-3">
                {outcome.achievements.map((a) => (
                  <div key={a.key} className="s-pop-in flex items-center gap-2 text-sm">
                    <span className="material-symbols-outlined text-[18px] text-student-gold-ink" style={{ fontVariationSettings: "'FILL' 1" }}>
                      {a.icon}
                    </span>
                    <span className="truncate font-semibold">{L({ ar: a.titleAr, en: a.titleEn })}</span>
                    <span className="ms-auto shrink-0 text-xs text-outline">{t('gamification.celebrate.achievement')}</span>
                  </div>
                ))}
                {outcome.missions.map((mi) => (
                  <div key={mi.id} className="flex items-center gap-2 text-sm">
                    <span className="material-symbols-outlined text-[18px] text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>
                      check_circle
                    </span>
                    <span className="truncate font-semibold">
                      {t([`gamification.missions.templates.${mi.template}`, mi.template])}
                    </span>
                    <span className="ms-auto shrink-0 text-xs font-bold text-student-gold-ink">+{mi.xpReward}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The same information, inline and permanent — for a results screen, where the
 * student is already stopped and reading.
 */
export function RewardSummary({ outcome }: { outcome: GamificationOutcome | null }) {
  const { t } = useTranslation();
  const L = useLocalized();
  if (!outcome?.awarded) return null;

  // The shared motion primitives, not an animation written here: a reward moment
  // should feel the same wherever it happens, and `prefers-reduced-motion` turns
  // all of them off in one place.
  return (
    <div className="card-gold rounded-xl border border-outline-variant bg-surface-container-lowest p-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {outcome.xp > 0 && (
          <span className="s-rise flex items-center gap-1.5 font-heading text-lg font-extrabold text-student-gold-ink">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>bolt</span>
            +{outcome.xp} {t('gamification.xp')}
          </span>
        )}
        {outcome.coins > 0 && (
          <span className="s-shine flex items-center gap-1.5 rounded-lg px-1 font-heading text-lg font-extrabold text-student-gold-ink">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>toll</span>
            +{outcome.coins} {t('gamification.coins')}
          </span>
        )}
        {outcome.leveledUp && (
          <span className="rounded-full bg-student-gold-soft px-3 py-1 text-sm font-bold text-student-gold-ink">
            {t('gamification.celebrate.levelUp', { n: outcome.level })}
          </span>
        )}
      </div>

      {(outcome.achievements.length > 0 || outcome.missions.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-outline-variant/50 pt-3">
          {outcome.achievements.map((a) => (
            <div key={a.key} className="s-pop-in flex items-center gap-2 text-sm">
              <span className="material-symbols-outlined text-[18px] text-student-gold-ink" style={{ fontVariationSettings: "'FILL' 1" }}>
                {a.icon}
              </span>
              <span className="font-semibold">{L({ ar: a.titleAr, en: a.titleEn })}</span>
              <span className="ms-auto text-xs text-outline">{t('gamification.celebrate.achievement')}</span>
            </div>
          ))}
          {outcome.missions.map((mi) => (
            <div key={mi.id} className="flex items-center gap-2 text-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary" style={{ fontVariationSettings: "'FILL' 1" }}>
                check_circle
              </span>
              <span className="font-semibold">
                {t([`gamification.missions.templates.${mi.template}`, mi.template])}
              </span>
              <span className="ms-auto text-xs font-bold text-student-gold-ink">+{mi.xpReward}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

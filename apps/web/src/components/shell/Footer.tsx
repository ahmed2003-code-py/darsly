import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { useGamification } from '../../lib/gamification';
import { useAuthStore } from '../../stores/auth';

/**
 * The foot of the page, when a theme wants one.
 *
 * The app has never had a footer; the default variant is still `none` and
 * renders nothing. `minimal` is a wordmark and a line. `stats` is the
 * student's XP, coins and streak — read from the same endpoint the level card
 * reads, so it can never disagree with it — and shown only to students,
 * because a teacher has none of those. `bottomBar` is rendered by the shell
 * itself, as a floating BottomNav, so it is not here.
 */
export default function Footer({ variant }: { variant: string }) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const isStudent = user?.role === Role.STUDENT;
  // The same query the level card uses, so the two can never disagree; it is
  // already cached on any page that shows the card.
  const { data } = useGamification(variant === 'stats' && isStudent);

  if (variant === 'minimal') {
    return (
      <footer className="shell-footer shell-footer-minimal mt-auto border-t border-outline-variant/30 px-6 py-5">
        <div className="mx-auto flex max-w-container flex-wrap items-center gap-x-6 gap-y-2 text-xs text-on-surface-variant">
          <span className="flex items-center gap-2 font-heading font-bold text-on-surface">
            <span className="brand-tile h-6 w-6" aria-hidden />
            {t('brand')}
          </span>
          <Link to="/profile" className="hover:text-on-surface">
            {t('nav.profile', 'الملف الشخصي')}
          </Link>
          <Link to="/messages" className="hover:text-on-surface">
            {t('nav.messages')}
          </Link>
          <span className="ms-auto">© {new Date().getFullYear()}</span>
        </div>
      </footer>
    );
  }

  if (variant === 'stats' && isStudent) {
    const g = data;
    const cell = (icon: string, value: string | number, label: string, cls: string) => (
      <span className="flex items-center gap-2">
        <span
          className={`material-symbols-outlined text-[18px] ${cls}`}
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          {icon}
        </span>
        <span className="font-heading text-sm font-extrabold tabular-nums">{value}</span>
        <span className="text-xs text-on-surface-variant">{label}</span>
      </span>
    );
    return (
      <footer className="shell-footer shell-footer-stats mt-auto border-t border-outline-variant/30 px-6 py-3">
        <div className="mx-auto flex max-w-container flex-wrap items-center gap-x-8 gap-y-2">
          {g ? (
            <>
              {cell('star', g.xp ?? 0, t('gamification.xp', 'نقطة'), 'text-student-gold-ink')}
              {cell('toll', g.coins ?? 0, t('gamification.coins', 'عملة'), 'text-student-gold-ink')}
              {cell(
                'local_fire_department',
                g.streak?.current ?? 0,
                t('gamification.streak', 'سلسلة'),
                'text-student-secondary-ink',
              )}
              {g.level && (
                <Link
                  to="/learning"
                  className="ms-auto text-xs font-bold text-student-accent-ink hover:underline"
                >
                  {t('gamification.level', 'المستوى')} {g.level.level}
                </Link>
              )}
            </>
          ) : (
            <span className="text-xs text-on-surface-variant">{t('brand')}</span>
          )}
        </div>
      </footer>
    );
  }

  return null;
}

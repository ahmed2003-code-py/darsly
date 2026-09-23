import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import type { NavItem } from './nav';

/**
 * The navigation, in whichever shape the theme asked for.
 *
 * One component. The variants are not six sidebars — they are one sidebar
 * whose width, chrome and label visibility the stylesheet decides from
 * `data-s-nav-desktop` on the root, plus two branches here: whether labels are
 * rendered at all (a rail), and whether the brand block is a tile or a tile
 * with a wordmark. Everything else — the items, the routes, the active state,
 * the account card — is identical across every variant, which is the point:
 * a theme changes what the navigation looks like, never where it goes.
 *
 * `labels` is passed in rather than read here so the drawer (which always has
 * room for labels) can reuse this with `labels` forced on.
 */
export default function Sidebar({
  nav,
  labels,
  roleLabel,
  onNavigate,
}: {
  nav: NavItem[];
  labels: boolean;
  roleLabel: string;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuthStore();

  return (
    <div className="shell-sidebar flex h-full flex-col">
      {/* Brand block. The tile is the real mark, themed rather than a fixed
          image; the wordmark and role line come and go with the labels. */}
      <div className="shell-brand flex items-center gap-3 px-5 py-6">
        <span className="brand-tile h-11 w-11 shrink-0" aria-hidden />
        {labels && (
          <div className="min-w-0">
            <h1 className="font-heading text-xl font-bold tracking-tight text-on-surface">
              {t('brand')}
            </h1>
            <p className="text-xs text-on-surface-variant">{roleLabel}</p>
          </div>
        )}
      </div>

      <nav className="shell-nav flex-1 space-y-0.5 px-3">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            title={labels ? undefined : t(item.labelKey)}
            className={({ isActive }) =>
              `studio-nav-item shell-nav-item group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 font-heading text-sm font-semibold transition-colors duration-200 ease-premium ${
                isActive
                  ? 'studio-active shell-nav-active bg-student-accent-soft text-student-accent-ink'
                  : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {/* The active indicator. Drawn as an element so the stylesheet
                    can make it a bar, a pill, a glow or an underline without
                    this file knowing which. */}
                {isActive && <span className="shell-nav-indicator" aria-hidden />}
                <span
                  className={`material-symbols-outlined shell-nav-icon text-[20px] ${
                    isActive
                      ? 'text-student-accent-ink'
                      : 'text-outline group-hover:text-on-surface'
                  }`}
                >
                  {item.icon}
                </span>
                {labels ? (
                  // `leading-5` matches the row's own `text-sm` line-height. The
                  // base stylesheet gives every span 1.6, and the label used to
                  // be a bare text node — wrapping it grew each row by 2.4px.
                  <span className="shell-nav-label truncate leading-5">{t(item.labelKey)}</span>
                ) : (
                  // A rail still says what it is — on hover, beside the icon.
                  <span className="shell-nav-tooltip" role="tooltip">
                    {t(item.labelKey)}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Account card at the foot → profile */}
      <div className="shell-account p-4">
        <NavLink
          to="/profile"
          onClick={onNavigate}
          title={labels ? undefined : (user?.fullName ?? undefined)}
          className="flex items-center gap-3 rounded-xl bg-surface-container-low p-3 transition hover:bg-surface-container"
        >
          <span className="studio-frame grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              (user?.fullName?.trim()?.charAt(0) ?? '?')
            )}
          </span>
          {labels && (
            <>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{user?.fullName}</p>
                <p className="truncate text-xs text-on-surface-variant">
                  {user?.role ? t(`dashboard.role.${user.role}`) : ''}
                </p>
              </div>
              <span className="material-symbols-outlined ms-auto text-lg text-outline rtl:-scale-x-100">
                chevron_right
              </span>
            </>
          )}
        </NavLink>
      </div>
    </div>
  );
}

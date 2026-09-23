import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import type { NavItem } from './nav';

/**
 * The phone's navigation: a fixed bar of the destinations that earned a
 * permanent spot, and "more" for the rest. Also what the `bottomBar` footer
 * variant renders on desktop, floated and detached — same items, same
 * component, one class on the wrapper.
 */
export default function BottomNav({
  tabs,
  onMore,
  floating = false,
}: {
  tabs: NavItem[];
  onMore: () => void;
  floating?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <nav
      className={
        floating
          ? 'shell-bottom-floating pointer-events-none fixed inset-x-0 bottom-4 z-40 hidden justify-center lg:flex'
          : 'shell-bottom fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/40 bg-surface-container-lowest/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden'
      }
    >
      <div
        className={
          floating
            ? 'pointer-events-auto flex items-stretch gap-1 rounded-full border border-outline-variant/40 bg-surface-container-lowest/90 px-2 py-1 shadow-elevated backdrop-blur-md'
            : 'flex items-stretch'
        }
      >
        {tabs.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={floating ? t(item.labelKey) : undefined}
            className={({ isActive }) =>
              floating
                ? `grid h-11 w-11 place-items-center rounded-full transition-colors ${
                    isActive
                      ? 'bg-student-accent-soft text-student-accent-ink'
                      : 'text-on-surface-variant hover:bg-surface-container-low'
                  }`
                : `flex min-h-[3.75rem] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 transition-colors ${
                    isActive ? 'text-student-accent-ink' : 'text-on-surface-variant'
                  }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`material-symbols-outlined text-[22px] leading-none ${
                    isActive ? 'text-student-accent-ink' : 'text-outline'
                  }`}
                  style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  {item.icon}
                </span>
                {!floating && (
                  <span className="w-full truncate text-center text-[11px] font-bold leading-tight">
                    {t(item.labelKey)}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
        {!floating && (
          <button
            type="button"
            onClick={onMore}
            className="flex min-h-[3.75rem] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 pb-1 pt-1.5 text-on-surface-variant transition-colors"
          >
            <span className="material-symbols-outlined text-[22px] leading-none text-outline">
              menu
            </span>
            <span className="w-full truncate text-center text-[11px] font-bold leading-tight">
              {t('nav.more')}
            </span>
          </button>
        )}
      </div>
    </nav>
  );
}

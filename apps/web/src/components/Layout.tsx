import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { useRealtime } from '../lib/useRealtime';
import { useWebNotifications } from '../lib/useWebNotifications';
import { useAuthStore } from '../stores/auth';
import NotificationToasts from './NotificationToasts';
import TopBar from './TopBar';

interface NavItem {
  to: string;
  icon: string;
  labelKey: string;
  end?: boolean;
}

const STUDENT_NAV: NavItem[] = [
  { to: '/', icon: 'space_dashboard', labelKey: 'nav.home', end: true },
  { to: '/courses', icon: 'auto_stories', labelKey: 'nav.browse' },
  { to: '/discover', icon: 'travel_explore', labelKey: 'nav.discover' },
  { to: '/my-courses', icon: 'menu_book', labelKey: 'nav.myCourses' },
  { to: '/learning', icon: 'trophy', labelKey: 'nav.learning' },
  { to: '/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/saved', icon: 'favorite', labelKey: 'nav.saved' },
  { to: '/live', icon: 'sensors', labelKey: 'nav.live' },
  { to: '/my-certificates', icon: 'workspace_premium', labelKey: 'nav.certificates' },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
];

const TEACHER_NAV: NavItem[] = [
  { to: '/teacher', icon: 'space_dashboard', labelKey: 'nav.dashboard', end: true },
  { to: '/academy/studio', icon: 'auto_awesome', labelKey: 'nav.studio' },
  { to: '/teacher/courses', icon: 'video_library', labelKey: 'nav.courseBuilder' },
  { to: '/teacher/students', icon: 'groups', labelKey: 'nav.myStudents' },
  { to: '/teacher/analytics', icon: 'monitoring', labelKey: 'nav.analytics' },
  { to: '/teacher/live', icon: 'sensors', labelKey: 'nav.live' },
  { to: '/messages', icon: 'forum', labelKey: 'nav.messages' },
  { to: '/teacher/wallet', icon: 'account_balance_wallet', labelKey: 'nav.wallet' },
  { to: '/teacher/security', icon: 'shield', labelKey: 'nav.security' },
  { to: '/teacher/coupons', icon: 'sell', labelKey: 'nav.coupons' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', icon: 'space_dashboard', labelKey: 'nav.adminOverview', end: true },
  { to: '/admin/teachers', icon: 'verified_user', labelKey: 'nav.adminTeachers' },
  { to: '/admin/academy-studio', icon: 'auto_awesome', labelKey: 'nav.adminStudio' },
  { to: '/admin/payments', icon: 'receipt_long', labelKey: 'nav.adminPayments' },
  { to: '/admin/wallet', icon: 'account_balance_wallet', labelKey: 'nav.adminWallet' },
  { to: '/admin/payouts', icon: 'payments', labelKey: 'nav.adminPayouts' },
  { to: '/admin/devices', icon: 'smartphone', labelKey: 'nav.adminDevices' },
  { to: '/admin/security', icon: 'gpp_maybe', labelKey: 'nav.adminSecurity' },
];

/**
 * The destinations that earn a permanent spot on a phone, per role —
 * everything else stays one tap away behind "more". Reaching anything on a
 * phone meant opening the drawer first, which is a tap and a decision in front
 * of the screens people actually live in: a student's courses, a teacher's
 * builder, an admin's queue, and now the wallet each of them checks.
 */
const BOTTOM_TABS: Record<string, string[]> = {
  [Role.STUDENT]: ['/', '/my-courses', '/learning', '/messages', '/wallet'],
  [Role.TEACHER]: ['/teacher', '/teacher/courses', '/teacher/students', '/messages', '/teacher/wallet'],
  [Role.SUPER_ADMIN]: ['/admin', '/admin/teachers', '/admin/payments', '/admin/wallet'],
};

/**
 * App shell: fixed sidebar on the inline-start edge (right in RTL) with a brand
 * block + nav, a sticky glassmorphic TopBar, and the routed page. Collapses to
 * an off-canvas drawer under lg, with a bottom tab bar for the common
 * destinations.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [drawer, setDrawer] = useState(false);
  const navigate = useNavigate();
  useRealtime(); // live bell + chat list on every authenticated page
  useWebNotifications(navigate); // ...and as OS notifications, clickable, when the tab is away
  const nav =
    user?.role === Role.SUPER_ADMIN ? ADMIN_NAV : user?.role === Role.TEACHER ? TEACHER_NAV : STUDENT_NAV;
  // Ordered by the tab list, not by where they happen to sit in the sidebar,
  // and drawn from the same entries so a renamed label can't drift between
  // the two navigations.
  const bottomTabs = (BOTTOM_TABS[user?.role ?? Role.STUDENT] ?? [])
    .map((to) => nav.find((n) => n.to === to))
    .filter((n): n is NavItem => !!n);
  const roleLabel =
    user?.role === Role.SUPER_ADMIN
      ? t('layout.adminConsole')
      : user?.role === Role.TEACHER
        ? t('layout.teacherConsole')
        : t('layout.studentSpace');

  const sidebar = (
    <div className="flex h-full flex-col">
      {/* Brand block — flat accent tile, editorial wordmark, start-aligned */}
      <div className="flex items-center gap-3 px-5 py-6">
        {/* The real mark, not a stock glyph — and the same artwork the browser
            tab uses, so the two can never drift apart. Drawn as a themed tile
            rather than a fixed image: once a teacher publishes their academy,
            an indigo square would be the one thing on screen still wearing the
            platform's colours. */}
        <span className="brand-tile h-11 w-11" aria-hidden />
        <div className="min-w-0">
          <h1 className="font-heading text-xl font-bold tracking-tight text-on-surface">{t('brand')}</h1>
          <p className="text-xs text-on-surface-variant">{roleLabel}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setDrawer(false)}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 font-heading text-sm font-semibold transition-colors duration-200 ease-premium ${
                isActive
                  ? 'bg-primary-fixed text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute inset-y-1.5 start-0 w-1 rounded-full bg-primary" aria-hidden />
                )}
                <span className={`material-symbols-outlined text-[20px] ${isActive ? 'text-primary' : 'text-outline group-hover:text-on-surface'}`}>
                  {item.icon}
                </span>
                {t(item.labelKey)}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Account card at the foot → profile */}
      <div className="p-4">
        <NavLink to="/profile" className="flex items-center gap-3 rounded-xl bg-surface-container-low p-3 transition hover:bg-surface-container">
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-primary">
            {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" /> : (user?.fullName?.trim()?.charAt(0) ?? '?')}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{user?.fullName}</p>
            <p className="truncate text-xs text-on-surface-variant">
              {user?.role ? t(`dashboard.role.${user.role}`) : ''}
            </p>
          </div>
          <span className="material-symbols-outlined ms-auto text-lg text-outline rtl:-scale-x-100">chevron_right</span>
        </NavLink>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-e border-outline-variant/40 bg-surface-container-lowest/80 backdrop-blur-sm lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer — the same navigation the desktop sidebar shows, so it
          belongs on the same side of the screen: `start`, which is the left in
          English and the right in Arabic. Anchoring it to `end` put it opposite
          both the desktop sidebar and the hamburger that opens it, and swapped
          sides between the two languages in exactly the wrong direction. */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-on-surface/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 start-0 w-64 border-e border-outline-variant/40 bg-surface-container-lowest shadow-modal">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onToggleSidebar={() => setDrawer(true)} />
        <NotificationToasts />
        {/* The bar is fixed, so the page has to end above it — including the
            home-indicator strip on phones that have one. */}
        <main className="min-w-0 flex-1 pb-[calc(4.25rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</main>
      </div>

      {/* Mobile bottom tab bar — the counterpart of the desktop sidebar, which
          is why it disappears at exactly the width the sidebar appears. */}
      {bottomTabs.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-outline-variant/40 bg-surface-container-lowest/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
          <div className="flex items-stretch">
            {bottomTabs.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex min-h-[3.75rem] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 transition-colors ${
                    isActive ? 'text-primary' : 'text-on-surface-variant'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`material-symbols-outlined text-[22px] leading-none ${isActive ? 'text-primary' : 'text-outline'}`}
                      style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                    >
                      {item.icon}
                    </span>
                    <span className="w-full truncate text-center text-[11px] font-bold leading-tight">
                      {t(item.labelKey)}
                    </span>
                  </>
                )}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={() => setDrawer(true)}
              className="flex min-h-[3.75rem] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-0.5 px-1 pb-1 pt-1.5 text-on-surface-variant transition-colors"
            >
              <span className="material-symbols-outlined text-[22px] leading-none text-outline">menu</span>
              <span className="w-full truncate text-center text-[11px] font-bold leading-tight">{t('nav.more')}</span>
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

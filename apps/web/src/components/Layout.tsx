import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { useRealtime } from '../lib/useRealtime';
import { useAuthStore } from '../stores/auth';
import TopBar from './TopBar';

interface NavItem {
  to: string;
  icon: string;
  labelKey: string;
  end?: boolean;
}

const STUDENT_NAV: NavItem[] = [
  { to: '/', icon: 'space_dashboard', labelKey: 'nav.home', end: true },
  { to: '/discover', icon: 'travel_explore', labelKey: 'nav.discover' },
  { to: '/my-courses', icon: 'menu_book', labelKey: 'nav.myCourses' },
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
  { to: '/teacher/payments', icon: 'receipt_long', labelKey: 'nav.verifyPayments' },
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
  { to: '/admin/payouts', icon: 'payments', labelKey: 'nav.adminPayouts' },
  { to: '/admin/security', icon: 'gpp_maybe', labelKey: 'nav.adminSecurity' },
];

/**
 * App shell: fixed sidebar on the inline-start edge (right in RTL) with a brand
 * block + nav, a sticky glassmorphic TopBar, and the routed page. Collapses to
 * an off-canvas drawer under lg.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [drawer, setDrawer] = useState(false);
  useRealtime(); // live bell + chat list on every authenticated page
  const nav =
    user?.role === Role.SUPER_ADMIN ? ADMIN_NAV : user?.role === Role.TEACHER ? TEACHER_NAV : STUDENT_NAV;
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
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-on-primary">
          <span className="material-symbols-outlined text-2xl">school</span>
        </div>
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
            {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" /> : (user?.fullName?.trim()?.charAt(0) ?? '؟')}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{user?.fullName}</p>
            <p className="truncate text-xs text-on-surface-variant">
              {user?.role ? t(`dashboard.role.${user.role}`) : ''}
            </p>
          </div>
          <span className="material-symbols-outlined ms-auto text-lg text-outline">chevron_left</span>
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

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-on-surface/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 end-0 w-64 border-s border-outline-variant/40 bg-surface-container-lowest shadow-modal">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onToggleSidebar={() => setDrawer(true)} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

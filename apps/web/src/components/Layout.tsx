import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { setLanguage } from '../i18n';
import { api } from '../lib/api';
import { useAuthStore } from '../stores/auth';

interface NavItem {
  to: string;
  icon: string;
  labelKey: string;
  end?: boolean;
}

const STUDENT_NAV: NavItem[] = [
  { to: '/', icon: 'space_dashboard', labelKey: 'nav.discover', end: true },
  { to: '/my-courses', icon: 'menu_book', labelKey: 'nav.myCourses' },
];

const TEACHER_NAV: NavItem[] = [
  { to: '/teacher', icon: 'space_dashboard', labelKey: 'nav.dashboard', end: true },
  { to: '/teacher/courses', icon: 'menu_book', labelKey: 'nav.courseBuilder' },
  { to: '/teacher/students', icon: 'school', labelKey: 'nav.myStudents' },
  { to: '/teacher/coupons', icon: 'sell', labelKey: 'nav.coupons' },
];

/**
 * App shell per the Stitch design: sidebar hugging the inline-start edge
 * (right in RTL), brand block on top, active item in a primary-tinted pill,
 * logout pinned to the bottom.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, clear } = useAuthStore();
  const nav = user?.role === Role.TEACHER ? TEACHER_NAV : STUDENT_NAV;

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      clear();
      navigate('/login');
    }
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-e border-outline-variant/40 bg-surface-container-lowest">
        <div className="flex flex-col items-center gap-2 px-6 py-8">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed">
            <span className="material-symbols-outlined text-3xl text-primary">school</span>
          </div>
          <h1 className="font-heading text-2xl font-extrabold text-primary">{t('brand')}</h1>
          <p className="text-xs text-on-surface-variant">
            {user?.role ? t(`dashboard.role.${user.role}`) : ''} · {user?.fullName}
          </p>
        </div>

        <nav className="flex-1 space-y-1 px-4">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-4 py-3 font-heading font-bold transition ${
                  isActive
                    ? 'bg-primary-fixed text-primary'
                    : 'text-on-surface-variant hover:bg-surface-container-low'
                }`
              }
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 border-t border-outline-variant/40 p-4">
          <button
            className="flex w-full items-center gap-3 rounded-lg px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container-low"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            <span className="material-symbols-outlined">translate</span>
            {t('common.language')}
          </button>
          <button
            className="flex w-full items-center gap-3 rounded-lg px-4 py-2 font-bold text-error hover:bg-error-container/40"
            onClick={logout}
          >
            <span className="material-symbols-outlined">logout</span>
            {t('dashboard.logout')}
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

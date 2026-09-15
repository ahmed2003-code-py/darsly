import { useQuery } from '@tanstack/react-query';
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../lib/api';
import { claimStudio, loadStudio } from '../lib/studio';
import { useRealtime } from '../lib/useRealtime';
import { useThemeLayout } from '../lib/useThemeLayout';
import { useWebNotifications } from '../lib/useWebNotifications';
import { useAuthStore } from '../stores/auth';
import NotificationToasts from './NotificationToasts';
import BottomNav from './shell/BottomNav';
import Footer from './shell/Footer';
import { BOTTOM_TABS, NavItem, navFor } from './shell/nav';
import Sidebar from './shell/Sidebar';
import TopBar from './TopBar';

/**
 * The app shell, in the shape the theme asked for.
 *
 * This file used to *be* the layout: one sidebar at one width, one header, a
 * bottom bar under `lg`, all decided here. It is a composition now. The theme
 * writes `data-s-*` attributes on the root; `useThemeLayout` reads them; this
 * picks which parts to render and passes each one its variant. The parts —
 * `Sidebar`, `TopBar`, `Footer`, `BottomNav` — are each one component drawn
 * from the same navigation list, so a theme changes what the shell looks like
 * and never where anything goes.
 *
 * With no theme, every value is the default and this renders exactly what the
 * old file rendered: the same classes on the same elements. That is not an
 * accident and it is the thing to protect — teachers and admins read the same
 * attributes and find nothing there.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [drawer, setDrawer] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const layout = useThemeLayout();
  useRealtime(); // live bell + chat list on every authenticated page
  useWebNotifications(navigate); // ...and as OS notifications, clickable, when the tab is away
  // A teacher who has closed messaging keeps no chat destination: the page
  // would be an empty list they cannot add to.
  const { data: teacherProfile } = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
    enabled: user?.role === Role.TEACHER,
    staleTime: 60_000,
  });
  const chatClosed = user?.role === Role.TEACHER && teacherProfile?.acceptsStudentMessages === false;

  // The student's own layer, fetched once the session is known. `bootStudio`
  // has already replayed the cached copy, so this is a correction rather than
  // the first paint. Claiming the device happens for every role: a look is
  // kept across a sign-out, and it is somebody *else* arriving that drops it.
  useEffect(() => {
    if (!user?.id) return;
    if (user.role === Role.STUDENT) void loadStudio(user.id).catch(() => undefined);
    else claimStudio(user.id);
  }, [user?.role, user?.id]);

  // The drawer closes itself on navigation, whichever surface opened it.
  useEffect(() => setDrawer(false), [location.pathname]);

  const baseNav = navFor(user?.role);
  const nav = chatClosed ? baseNav.filter((n) => n.to !== '/messages') : baseNav;
  const bottomTabs = (BOTTOM_TABS[user?.role ?? Role.STUDENT] ?? [])
    .map((to) => nav.find((n) => n.to === to))
    .filter((n): n is NavItem => !!n);
  const roleLabel =
    user?.role === Role.SUPER_ADMIN
      ? t('layout.adminConsole')
      : user?.role === Role.TEACHER
        ? t('layout.teacherConsole')
        : t('layout.studentSpace');

  const { nav: navCfg, header, footer } = layout;
  const desktopNav = navCfg.desktop;
  const showSidebar = desktopNav !== 'hidden';
  // A rail shows labels only on hover, whatever the theme said about labels.
  const sidebarLabels = desktopNav === 'rail' ? false : navCfg.labels;
  const title = typeof document !== 'undefined' ? document.title.replace(/\s*[|—-]\s*.*$/, '') : undefined;

  const sidebar = (labels: boolean) => (
    <Sidebar nav={nav} labels={labels} roleLabel={roleLabel} onNavigate={() => setDrawer(false)} />
  );

  return (
    <div className="shell flex min-h-screen" data-shell-nav={desktopNav} data-shell-tablet={navCfg.tablet}>
      {/* Desktop sidebar. Hidden below `lg` by the base rule; the tablet
          variant can bring it back between `md` and `lg` as a rail. */}
      {showSidebar && (
        <aside className="shell-aside sticky top-0 hidden h-screen w-64 shrink-0 border-e border-outline-variant/40 bg-surface-container-lowest/80 backdrop-blur-sm lg:block">
          {sidebar(sidebarLabels)}
        </aside>
      )}

      {/* Mobile drawer — the same navigation, always with labels, on the
          `start` side (left in English, right in Arabic) where the hamburger is. */}
      {drawer && (
        <div className={`fixed inset-0 z-50 ${showSidebar ? 'lg:hidden' : ''}`}>
          <div className="absolute inset-0 bg-on-surface/40" onClick={() => setDrawer(false)} />
          <aside className="shell-drawer absolute inset-y-0 start-0 w-64 border-e border-outline-variant/40 bg-surface-container-lowest shadow-modal">
            {sidebar(true)}
          </aside>
        </div>
      )}

      <div className="shell-main flex min-w-0 flex-1 flex-col">
        {/* With no sidebar, the header carries the primary destinations —
            the same five the phone's bar carries — and the drawer holds the
            rest. Eleven links do not fit across a header, and a horizontal
            nav that scrolls is a nav nobody finds the end of. */}
        <TopBar
          onToggleSidebar={() => setDrawer(true)}
          alwaysMenu={!showSidebar}
          variant={header.variant}
          sticky={header.sticky}
          nav={showSidebar ? undefined : bottomTabs}
          title={title}
        />
        <NotificationToasts />
        {/* The phone's bar is fixed, so the page ends above it — including the
            home-indicator strip on phones that have one. Only when there is a
            bar: a theme that uses the drawer alone gets the room back. */}
        <main
          className={`shell-content min-w-0 flex-1 ${
            navCfg.mobile === 'bottom' ? 'pb-[calc(4.25rem+env(safe-area-inset-bottom))] lg:pb-0' : ''
          } ${footer === 'bottomBar' ? 'lg:pb-24' : ''}`}
        >
          {children}
        </main>
        <Footer variant={footer} />
      </div>

      {/* Phone navigation: the bar, or nothing but the drawer. */}
      {navCfg.mobile === 'bottom' && bottomTabs.length > 0 && (
        <BottomNav tabs={bottomTabs} onMore={() => setDrawer(true)} />
      )}
      {/* The floating bottom bar a theme may ask for on desktop. */}
      {footer === 'bottomBar' && bottomTabs.length > 0 && (
        <BottomNav tabs={bottomTabs} onMore={() => setDrawer(true)} floating />
      )}
    </div>
  );
}

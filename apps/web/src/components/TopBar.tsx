import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { setLanguage } from '../i18n';
import ColorModeToggle from './ColorModeToggle';
import { api } from '../lib/api';
import { notificationLook, timeAgo } from '../lib/notificationLook';
import { notificationRoute } from '../lib/notificationRoute';
import { useNotificationPermission } from '../lib/useWebNotifications';
import { useAuthStore } from '../stores/auth';
import { NavLink, useLocation } from 'react-router-dom';
import type { NavItem } from './shell/nav';

/**
 * The header, in whichever shape the theme asked for.
 *
 * One component; the variant is a class on the wrapper and two decisions here.
 * `standard` is the app as it was — sticky glass, start-aligned search, the
 * controls at the end. The others move or shrink those same parts: `compact`
 * and `minimal` fold the search into an icon, `editorial` grows tall and
 * carries the page's own title, `centered` gives the search the whole middle,
 * `floating` detaches from the edge. When the sidebar is `hidden`, this is
 * also where the navigation lives — passed in as `nav`, drawn from the same
 * list the sidebar draws from.
 *
 * Search routes students to discovery; the bell opens live notifications; the
 * avatar opens a small account menu. None of that changes with the variant.
 */
export default function TopBar({
  onToggleSidebar,
  alwaysMenu = false,
  variant = 'standard',
  sticky = true,
  nav,
  title,
}: {
  onToggleSidebar?: () => void;
  /** Show the menu button at every width, not only under `lg`. */
  alwaysMenu?: boolean;
  variant?: string;
  sticky?: boolean;
  /** Navigation to carry in the header itself, when there is no sidebar. */
  nav?: NavItem[];
  /** The page's own title, for the editorial variant. */
  title?: string;
}) {
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  // A folded search that was opened stays open only on the page it was opened
  // on; the next page starts folded again.
  useEffect(() => setSearchOpen(false), [location.pathname]);
  // Variants that fold the search into an icon until it is asked for.
  const foldedSearch = (variant === 'compact' || variant === 'minimal') && !searchOpen;
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, clear } = useAuthStore();
  const [q, setQ] = useState('');
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { permission, request, supported } = useNotificationPermission();

  const { data: notif } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get('/notifications')).data,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    navigate(user?.role === Role.TEACHER ? `/teacher/courses?q=${encodeURIComponent(q)}` : `/courses?q=${encodeURIComponent(q)}`);
  }

  async function markAllRead() {
    await api.patch('/notifications/read-all');
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }

  // Read is not the same as done with. Without these the bell only ever grew.
  async function clearAll() {
    if (!window.confirm(t('topbar.clearAllConfirm'))) return;
    await api.delete('/notifications/all');
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }
  async function dismiss(id: string) {
    await api.delete(`/notifications/${id}`);
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }
  /** Mark it read and go where it points — a notification you can't follow is
   *  just a label. */
  async function openNotif(n: { id: string; readAt?: string | null; type?: string; meta?: Record<string, unknown> }) {
    setBellOpen(false);
    if (!n.readAt) {
      await api.patch(`/notifications/${n.id}/read`).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
    const to = notificationRoute(n, user?.role);
    if (to) navigate(to);
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      clear();
      navigate('/login');
    }
  }

  const initial = user?.fullName?.trim()?.charAt(0) ?? '?';

  const wrapper = [
    'shell-header',
    `shell-header-${variant}`,
    sticky ? 'sticky top-0' : '',
    'z-40',
    // Standard keeps the exact class it always had; the others are drawn by
    // the stylesheet under their own name.
    variant === 'standard' ? 'glass' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <header className={wrapper} data-variant={variant}>
      <div className="shell-header-row flex h-16 items-center gap-2 px-4 sm:gap-4 sm:px-6">
        {onToggleSidebar && (
          <button
            className={`shell-menu-btn grid h-10 w-10 shrink-0 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-low ${alwaysMenu ? '' : 'lg:hidden'}`}
            onClick={onToggleSidebar}
            aria-label="menu"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}

        {/* The brand, when there is no sidebar to carry it. */}
        {nav && (
          <span className="shell-header-brand hidden items-center gap-2 lg:flex">
            <span className="brand-tile h-9 w-9" aria-hidden />
            <span className="font-heading text-lg font-bold tracking-tight text-on-surface">{t('brand')}</span>
          </span>
        )}

        {/* The page's title, for a header tall enough to carry it. */}
        {variant === 'editorial' && title && (
          <h1 className="shell-header-title me-auto hidden min-w-0 truncate font-heading text-2xl font-bold tracking-tight text-on-surface lg:block">
            {title}
          </h1>
        )}

        {/* The navigation itself, when the sidebar is hidden. */}
        {nav && (
          <nav className="shell-header-nav hidden shrink-0 items-center gap-1 lg:flex">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `shell-nav-item relative flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 font-heading text-sm font-semibold transition-colors ${
                    isActive
                      ? 'studio-active shell-nav-active bg-student-accent-soft text-student-accent-ink'
                      : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface'
                  }`
                }
              >
                <span className="material-symbols-outlined text-[18px]">{item.icon}</span>
                <span className="shell-nav-label leading-5">{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </nav>
        )}

        {/* Search — start-aligned by default; the whole middle in `centered`;
            an icon until asked for in the compact variants. */}
        {foldedSearch ? (
          <button
            className="shell-search-btn me-auto grid h-10 w-10 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
            onClick={() => setSearchOpen(true)}
            aria-label={t('topbar.searchPlaceholder')}
          >
            <span className="material-symbols-outlined">search</span>
          </button>
        ) : (
          <form
            onSubmit={submitSearch}
            className={`shell-search min-w-0 flex-1 ${
              // With the nav in the row the search takes what is left; on its
              // own it takes the middle (centered) or the start (standard).
              nav
                ? 'max-w-md'
                : variant === 'centered'
                  ? 'mx-auto max-w-xl'
                  : variant === 'editorial'
                    ? 'ms-auto max-w-xs'
                    : 'me-auto max-w-md'
            }`}
          >
            <div className="flex items-center gap-2 rounded-full border border-outline-variant bg-surface-container-lowest px-4 py-2 transition-[border-color,box-shadow] duration-150 ease-premium focus-within:border-accent-500 focus-within:ring-4 focus-within:ring-accent-500/10">
              <span className="material-symbols-outlined text-[20px] text-outline">search</span>
              <input
                className="w-full bg-transparent text-sm outline-none placeholder:text-outline"
                placeholder={t('topbar.searchPlaceholder')}
                value={q}
                autoFocus={searchOpen}
                onBlur={() => !q && setSearchOpen(false)}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </form>
        )}

        <div className="shell-header-controls flex shrink-0 items-center gap-2 sm:gap-1">
          {/* Light or dark — the same switch the public academy page carries,
              so the choice a visitor made out there is still theirs in here. */}
          <ColorModeToggle />

          {/* Language */}
          <button
            className="grid h-10 w-10 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
            onClick={() => void setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
            title={t('common.language')}
          >
            <span className="material-symbols-outlined">translate</span>
          </button>

          {/* Notifications */}
          <div className="relative" ref={bellRef}>
            <button
              className="relative grid h-10 w-10 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
              onClick={() => setBellOpen((v) => !v)}
              aria-label="notifications"
            >
              <span className="material-symbols-outlined">notifications</span>
              {notif?.unread > 0 && (
                <span className="absolute end-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-error px-1 text-[10px] font-bold text-on-error">
                  {notif.unread > 9 ? '9+' : notif.unread}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute end-0 mt-2 w-80 overflow-hidden rounded-xl bg-surface-container-lowest shadow-modal">
                <div className="flex items-center gap-3 border-b border-outline-variant/40 px-4 py-3">
                  <span className="me-auto font-heading font-bold">{t('topbar.notifications')}</span>
                  {notif?.unread > 0 && (
                    <button className="text-xs font-bold text-primary hover:underline" onClick={markAllRead}>
                      {t('topbar.markAllRead')}
                    </button>
                  )}
                  {notif?.items?.length > 0 && (
                    <button className="text-xs font-bold text-error hover:underline" onClick={clearAll}>
                      {t('topbar.clearAll')}
                    </button>
                  )}
                </div>
                {/* Asking here rather than on load: the browser only honours a
                    request that follows a real click, and this is the one place
                    a user has just shown they care about notifications. Hidden
                    once answered — a denial can only be undone in browser
                    settings, so re-offering the button would do nothing. */}
                {supported && permission === 'default' && (
                  <button
                    onClick={() => void request()}
                    className="flex w-full items-center gap-2 border-b border-outline-variant/40 bg-primary-fixed/40 px-4 py-3 text-start text-xs font-bold text-on-primary-fixed transition hover:bg-primary-fixed"
                  >
                    <span className="material-symbols-outlined text-[18px]">notifications_active</span>
                    {t('topbar.enablePush')}
                  </button>
                )}
                <div className="max-h-96 overflow-y-auto">
                  {!notif?.items?.length ? (
                    <p className="px-4 py-8 text-center text-sm text-outline">{t('topbar.noNotifications')}</p>
                  ) : (
                    notif.items.map((n: any) => {
                      const look = notificationLook(n);
                      return (
                        // The row opens it; the bin beside it removes it. They
                        // are siblings rather than nested, because a button
                        // inside a button is not a thing a browser can do.
                        <div
                          key={n.id}
                          className={`group/notif flex items-start gap-1 border-b border-outline-variant/30 transition hover:bg-surface-container-low ${
                            n.readAt ? '' : 'bg-primary-fixed/30'
                          }`}
                        >
                          <button
                            onClick={() => void openNotif(n)}
                            className="flex min-w-0 flex-1 gap-3 py-3 ps-4 text-start"
                          >
                            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${look.tone}`}>
                              <span className="material-symbols-outlined text-[20px]">{look.icon}</span>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-sm font-bold">{n.title}</span>
                                {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                              </span>
                              <span className="block text-xs text-on-surface-variant line-clamp-2">{n.body}</span>
                              <span className="mt-1 block text-[11px] text-outline">
                                {timeAgo(n.createdAt, t, i18n.language)}
                              </span>
                            </span>
                          </button>
                          <button
                            onClick={() => void dismiss(n.id)}
                            title={t('topbar.dismiss')}
                            aria-label={t('topbar.dismiss')}
                            className="me-2 mt-3 grid h-8 w-8 shrink-0 place-items-center rounded-full text-outline transition hover:bg-error-container hover:text-on-error-container sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover/notif:opacity-100"
                          >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User menu */}
          <div className="relative" ref={menuRef}>
            <button
              className="ms-1 flex items-center gap-2 rounded-full p-1 transition hover:bg-surface-container-low"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {/* The photo when there is one. An initial identifies an account;
                  a face identifies a person, and this is the one place the
                  teacher sees themselves on every screen. */}
              <span className="studio-frame grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  initial
                )}
              </span>
            </button>
            {menuOpen && (
              <div className="absolute end-0 mt-2 w-56 overflow-hidden rounded-xl bg-surface-container-lowest shadow-modal">
                <div className="border-b border-outline-variant/40 px-4 py-3">
                  <p className="truncate font-bold">{user?.fullName}</p>
                  <p className="text-xs text-on-surface-variant">
                    {user?.role ? t(`dashboard.role.${user.role}`) : ''}
                  </p>
                </div>
                <button
                  className="flex w-full items-center gap-2 px-4 py-3 text-start text-sm font-bold text-error transition hover:bg-error-container/40"
                  onClick={logout}
                >
                  <span className="material-symbols-outlined text-base">logout</span>
                  {t('dashboard.logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

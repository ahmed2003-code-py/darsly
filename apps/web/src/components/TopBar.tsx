import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { setLanguage } from '../i18n';
import { api } from '../lib/api';
import { dateShort } from '../lib/format';
import { useAuthStore } from '../stores/auth';

/**
 * Global glassmorphic top bar (design: sticky, backdrop-blur, centered search,
 * notifications, user menu). Search routes students to discovery; the bell
 * opens live in-app notifications; the avatar opens a small account menu.
 */
export default function TopBar({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, clear } = useAuthStore();
  const [q, setQ] = useState('');
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    navigate(user?.role === Role.TEACHER ? `/teacher/courses?q=${encodeURIComponent(q)}` : `/?q=${encodeURIComponent(q)}`);
  }

  async function markAllRead() {
    await api.patch('/notifications/read-all');
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }
  async function openNotif(id: string, read: boolean) {
    if (!read) {
      await api.patch(`/notifications/${id}/read`);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      clear();
      navigate('/login');
    }
  }

  const initial = user?.fullName?.trim()?.charAt(0) ?? '؟';

  return (
    <header className="glass sticky top-0 z-40">
      <div className="flex h-16 items-center gap-4 px-6">
        {onToggleSidebar && (
          <button
            className="grid h-10 w-10 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-low lg:hidden"
            onClick={onToggleSidebar}
            aria-label="menu"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}

        {/* Centered search */}
        <form onSubmit={submitSearch} className="mx-auto w-full max-w-xl">
          <div className="flex items-center gap-2 rounded-full border border-outline-variant/70 bg-surface-container-lowest px-4 py-2.5 shadow-sm transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/40">
            <span className="material-symbols-outlined text-outline">search</span>
            <input
              className="w-full bg-transparent text-sm outline-none placeholder:text-outline"
              placeholder={t('topbar.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </form>

        <div className="flex items-center gap-1">
          {/* Language */}
          <button
            className="grid h-10 w-10 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
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
                <div className="flex items-center justify-between border-b border-outline-variant/40 px-4 py-3">
                  <span className="font-heading font-bold">{t('topbar.notifications')}</span>
                  {notif?.unread > 0 && (
                    <button className="text-xs text-primary hover:underline" onClick={markAllRead}>
                      {t('topbar.markAllRead')}
                    </button>
                  )}
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {!notif?.items?.length ? (
                    <p className="px-4 py-8 text-center text-sm text-outline">{t('topbar.noNotifications')}</p>
                  ) : (
                    notif.items.map((n: any) => (
                      <button
                        key={n.id}
                        onClick={() => openNotif(n.id, !!n.readAt)}
                        className={`flex w-full gap-3 border-b border-outline-variant/30 px-4 py-3 text-start transition hover:bg-surface-container-low ${
                          n.readAt ? '' : 'bg-primary-fixed/30'
                        }`}
                      >
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-primary'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold text-sm">{n.title}</span>
                          <span className="block text-xs text-on-surface-variant line-clamp-2">{n.body}</span>
                          <span className="mt-1 block text-[11px] text-outline">{dateShort(n.createdAt)}</span>
                        </span>
                      </button>
                    ))
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
              <span className="grid h-9 w-9 place-items-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                {initial}
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

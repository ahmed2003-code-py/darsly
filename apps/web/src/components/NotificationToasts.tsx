import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { RealtimeEvents } from '@darsly/shared-types';
import { api } from '../lib/api';
import { notificationRoute } from '../lib/notificationRoute';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../stores/auth';

interface Toast {
  id: string;
  notifId?: string;
  title: string;
  body: string;
  to: string | null;
}

const VISIBLE_MS = 9_000;

/**
 * The in-app half of notifications: a card that appears when something arrives
 * while you are looking at the page.
 *
 * Live arrivals only, on purpose. This used to replay your unread items on
 * every page load, which meant three cards shouting the same old news at every
 * refresh — and because dismissing a toast does not mark anything read (it
 * should not; "not now" is not "seen"), they came back for ever. A toast is
 * about *recency*; unread state belongs to the bell, which already carries a
 * count and the full history.
 *
 * The OS notification in `useWebNotifications` covers the other half — the tab
 * you are not looking at — and the two deliberately never both fire: that one
 * bails while the page is visible, this one only runs while it is.
 */
export default function NotificationToasts() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
    window.clearTimeout(timers.current[id]);
    delete timers.current[id];
  }, []);

  const push = useCallback(
    (toast: Toast) => {
      setToasts((prev) =>
        prev.some((x) => x.id === toast.id) ? prev : [toast, ...prev].slice(0, 4),
      );
      timers.current[toast.id] = window.setTimeout(() => dismiss(toast.id), VISIBLE_MS);
    },
    [dismiss],
  );

  // What arrived while you were here.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onNotification = (n: any) => {
      if (document.visibilityState !== 'visible') return; // the OS notification has it
      if (!n?.title) return;
      push({
        id: `n-${n.id}`,
        notifId: n.id,
        title: n.title,
        body: n.body ?? '',
        to: notificationRoute(n, role),
      });
    };
    socket.on(RealtimeEvents.NOTIFICATION, onNotification);
    return () => {
      socket.off(RealtimeEvents.NOTIFICATION, onNotification);
    };
  }, [push, role]);

  useEffect(() => () => Object.values(timers.current).forEach((x) => window.clearTimeout(x)), []);

  const open = async (toast: Toast) => {
    dismiss(toast.id);
    if (toast.notifId) {
      await api.patch(`/notifications/${toast.notifId}/read`).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
    if (toast.to) navigate(toast.to);
  };

  if (!toasts.length) return null;

  return (
    // Above the bottom tab bar on a phone, clear of the top bar on a desktop.
    <div className="pointer-events-none fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:inset-x-auto sm:end-4 sm:top-20 sm:bottom-auto sm:w-96 lg:bottom-auto">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest p-3 shadow-modal"
        >
          <button
            className="flex min-w-0 flex-1 items-start gap-3 text-start"
            onClick={() => void open(toast)}
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
              <span className="material-symbols-outlined text-[20px]">notifications</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold">{toast.title}</span>
              {toast.body && (
                <span className="line-clamp-2 block text-xs text-on-surface-variant">
                  {toast.body}
                </span>
              )}
            </span>
          </button>
          <button
            onClick={() => dismiss(toast.id)}
            aria-label={t('common.close')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline transition hover:bg-surface-container"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      ))}
    </div>
  );
}

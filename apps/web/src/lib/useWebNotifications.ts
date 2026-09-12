import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeEvents } from '@darsly/shared-types';
import { notificationRoute } from './notificationRoute';
import { getSocket } from './socket';
import { useAuthStore } from '../stores/auth';

/**
 * Mirrors the realtime bell into the operating system's own notifications, so
 * a teacher waiting on a top-up or a student waiting on a reply doesn't have
 * to keep the tab in front of them.
 *
 * This is the in-page Notification API, not Web Push: it reaches the user
 * whenever the site is open somewhere — including a background tab or a
 * minimised window — and stops when they close the last tab. Real push
 * delivery to a closed browser needs a VAPID key pair, a stored subscription
 * per device and a `push` handler in the service worker; that is a separate
 * piece of work, and this one is useful without it.
 */

/** `null` when the browser has no Notification API at all (older iOS Safari). */
export type NotifPermission = NotificationPermission | null;

export function notificationPermission(): NotifPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  return Notification.permission;
}

/**
 * Permission state plus the request call. Asking must come from something the
 * user actually clicked — browsers ignore an unprompted request, and Chrome
 * holds it against a site that asks on load.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotifPermission>(notificationPermission);

  const request = useCallback(async () => {
    if (!('Notification' in window)) return null;
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  return { permission, request, supported: permission !== null };
}

/** Read at fire time, not render time — the listeners are bound once. */
const roleOf = () => useAuthStore.getState().user?.role;

/** Fires only when the tab isn't the one being looked at. */
function show(title: string, body: string, tag: string, onOpen?: () => void) {
  if (notificationPermission() !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    // `tag` collapses repeats — ten messages in one thread replace each other
    // instead of stacking ten deep in the notification tray.
    const n = new Notification(title, { body, tag, icon: '/icon-192.png', badge: '/icon-192.png' });
    n.onclick = () => {
      // Bring the tab forward first: navigating a background tab lands the
      // user somewhere they never saw happen.
      window.focus();
      n.close();
      onOpen?.();
    };
  } catch {
    /* Some browsers only allow construction from a service worker; ignore. */
  }
}

/**
 * Bridges realtime events to OS notifications. Mounted once, next to
 * `useRealtime` — it only listens, and never touches the query cache.
 *
 * `navigate` is what makes a notification worth tapping: it hands back the
 * route the event belongs to, so a message opens its thread rather than the
 * page the user happened to leave open.
 */
export function useWebNotifications(navigate?: (to: string) => void) {
  // Kept in a ref so a new function identity on every render doesn't tear the
  // socket listeners down and rebuild them.
  const go = useRef(navigate);
  go.current = navigate;

  useEffect(() => {
    if (!('Notification' in window)) return;
    const socket = getSocket();
    if (!socket) return;

    const onNotification = (n: { id?: string; title?: string; body?: string; type?: string; meta?: Record<string, unknown> }) => {
      if (!n?.title) return;
      const to = notificationRoute(n, roleOf());
      show(n.title, n.body ?? '', `notif-${n.id ?? n.title}`, to ? () => go.current?.(to) : undefined);
    };
    const onMessage = (m: { threadId?: string; senderName?: string; body?: string; mine?: boolean }) => {
      // The sender gets the same event echoed back; don't notify them of
      // their own message.
      if (!m || m.mine) return;
      const to = m.threadId ? `/messages?t=${m.threadId}` : '/messages';
      show(m.senderName ?? '', m.body ?? '', `chat-${m.threadId ?? ''}`, () => go.current?.(to));
    };

    socket.on(RealtimeEvents.NOTIFICATION, onNotification);
    socket.on(RealtimeEvents.MESSAGE, onMessage);
    return () => {
      socket.off(RealtimeEvents.NOTIFICATION, onNotification);
      socket.off(RealtimeEvents.MESSAGE, onMessage);
    };
  }, []);
}

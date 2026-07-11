import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RealtimeEvents } from '@darsly/shared-types';
import { getSocket } from './socket';
import { useAuthStore } from '../stores/auth';

/**
 * App-wide realtime wiring: keeps the notification bell + chat thread list
 * fresh as events arrive. Mounted once in the Layout. Screen-specific live
 * updates (appending a message to an open conversation) are handled where that
 * screen subscribes to the same socket.
 */
export function useRealtime() {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const refreshNotifs = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
    const refreshThreads = () => queryClient.invalidateQueries({ queryKey: ['chat-threads'] });

    socket.on(RealtimeEvents.NOTIFICATION, refreshNotifs);
    socket.on(RealtimeEvents.UNREAD_COUNT, refreshNotifs);
    socket.on(RealtimeEvents.THREAD_UPDATED, refreshThreads);
    socket.on(RealtimeEvents.MESSAGE, refreshThreads);

    return () => {
      socket.off(RealtimeEvents.NOTIFICATION, refreshNotifs);
      socket.off(RealtimeEvents.UNREAD_COUNT, refreshNotifs);
      socket.off(RealtimeEvents.THREAD_UPDATED, refreshThreads);
      socket.off(RealtimeEvents.MESSAGE, refreshThreads);
    };
  }, [queryClient, token]);
}

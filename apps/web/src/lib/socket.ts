import { io, Socket } from 'socket.io-client';
import { apiOrigin } from './api';
import { useAuthStore } from '../stores/auth';

/**
 * Single shared Socket.io connection, authenticated with the current access
 * token. Reconnects with a fresh token when auth changes. Components subscribe
 * via getSocket() and add their own listeners.
 */
let socket: Socket | null = null;
let boundToken: string | null = null;

export function getSocket(): Socket | null {
  const token = useAuthStore.getState().accessToken;
  if (!token) {
    socket?.close();
    socket = null;
    boundToken = null;
    return null;
  }
  if (socket && boundToken === token) return socket;

  // Token changed (login / refresh) — reconnect with the new one.
  socket?.close();
  boundToken = token;
  socket = io(apiOrigin() || window.location.origin, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
  });
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
  boundToken = null;
}

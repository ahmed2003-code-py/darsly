import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getSocket } from './socket';

/**
 * The classroom's chat, on the connection the app already has.
 *
 * No second socket and no polling: `getSocket()` is the same authenticated
 * connection the messages page uses, and the server admits this client to the
 * session's room only after asking the same question it asks at the door of the
 * meeting itself.
 */

export interface LiveMessage {
  id: string;
  body: string;
  createdAt: string;
  senderId: string;
  senderName: string;
  senderRole: string;
}

export function useLiveChat(sessionId: string, open: boolean) {
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [sending, setSending] = useState(false);
  // What "unread" counts against: messages that arrived while the panel was shut.
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let cancelled = false;
    void api
      .get(`/live/${sessionId}/chat`)
      .then(({ data }) => {
        if (!cancelled) setMessages(data);
      })
      .catch(() => undefined);

    const s = getSocket();
    if (!s)
      return () => {
        cancelled = true;
      };
    s.emit('live:join', sessionId);
    const onMessage = (m: LiveMessage) => {
      setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      if (!openRef.current) setUnread((n) => n + 1);
    };
    s.on('live:message', onMessage);
    // Rejoining after a dropped connection: the room membership lives on the
    // socket, so a reconnect that does not re-announce itself is a silent chat.
    const onReconnect = () => s.emit('live:join', sessionId);
    s.on('connect', onReconnect);
    return () => {
      cancelled = true;
      s.off('live:message', onMessage);
      s.off('connect', onReconnect);
      s.emit('live:leave', sessionId);
    };
  }, [sessionId]);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open, messages.length]);

  const send = useCallback(
    async (body: string) => {
      const text = body.trim();
      if (!text) return;
      setSending(true);
      try {
        // Posted over HTTP, delivered over the socket: one path that persists
        // and authorises, rather than two that could disagree.
        const { data } = await api.post(`/live/${sessionId}/chat`, { body: text });
        setMessages((cur) => (cur.some((x) => x.id === data.id) ? cur : [...cur, data]));
      } finally {
        setSending(false);
      }
    },
    [sessionId],
  );

  return { messages, unread, sending, send };
}

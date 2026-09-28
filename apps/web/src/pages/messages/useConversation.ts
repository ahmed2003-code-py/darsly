import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatMessageDto, RealtimeEvents } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import {
  LocalMessage,
  localId,
  mergeMessages,
  newestStored,
  oldestStored,
  setLocalStatus,
} from './messageList';

/** Must match the API's default page (MESSAGE_PAGE); a full page means there may be more. */
export const PAGE = 40;
/** How often an open conversation asks for what is new, in case the socket missed it. */
const POLL_MS = 5_000;

/**
 * Who a message goes to: an existing conversation, or a person the caller may
 * start one with. The conversation is created by the server with the first
 * message — never by opening the page.
 */
export type SendTarget = { threadId: string } | { studentId: string } | { tenantId: string };

export interface SendInput {
  body: string;
  replyTo?: ChatMessageDto | null;
}

/**
 * One open conversation's messages.
 *
 * - Opens on the NEWEST page; `loadOlder` pages back by keyset on the oldest
 *   message shown, so nothing is skipped or repeated while messages arrive.
 * - Stays current three ways that all feed one merge: the socket (fast), a
 *   poll for messages newer than the newest one shown (the socket is not a
 *   guarantee on a phone that slept), and each send's own response.
 * - Sends carry a clientMessageId. The bubble shows at once; a failed send
 *   stays on screen with a retry, and a retry reuses the same id, so a send
 *   that actually reached the server before the connection dropped is stored
 *   once, not twice.
 *
 * `threadId` is null for a conversation that does not exist yet: the hook
 * holds the sends until the first one returns the new conversation's id.
 */
export function useConversation(
  threadId: string | null,
  me: { id: string; name: string; role: ChatMessageDto['senderRole'] },
) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loaded, setLoaded] = useState(!threadId);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Read by callbacks that must see the latest list without re-subscribing. */
  const listRef = useRef<LocalMessage[]>([]);
  listRef.current = messages;
  /** Sends by client id, so a retry resends exactly what was written. */
  const sendsRef = useRef(
    new Map<string, { target: SendTarget; body: string; replyToId?: string }>(),
  );

  const merge = useCallback((incoming: ChatMessageDto[]) => {
    setMessages((prev) => mergeMessages(prev, incoming));
  }, []);

  // Opening a conversation: its newest page. Moving from "no conversation yet"
  // to the one the first send created keeps what is already on screen.
  useEffect(() => {
    let cancelled = false;
    setMessages((prev) => (threadId ? prev.filter((m) => m.threadId === threadId) : []));
    setError(null);
    setHasOlder(false);
    if (!threadId) {
      setLoaded(true);
      return;
    }
    setLoaded(false);
    api
      .get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`)
      .then(({ data }) => {
        if (cancelled) return;
        merge(data);
        setHasOlder(data.length >= PAGE);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, merge]);

  // What is new since the newest message shown. A cursor the server no longer
  // knows (the conversation was cleared) falls back to the newest page.
  const catchUp = useCallback(async () => {
    if (!threadId) return;
    const newest = newestStored(listRef.current);
    try {
      const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`, {
        params: newest ? { after: newest.id, limit: 100 } : {},
      });
      merge(data);
    } catch (e: any) {
      if (e?.response?.data?.code === 'CURSOR_UNKNOWN') {
        const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`);
        setMessages(mergeMessages([], data));
      }
    }
  }, [threadId, merge]);

  useEffect(() => {
    if (!threadId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void catchUp();
    }, POLL_MS);
    const onFocus = () => void catchUp();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [threadId, catchUp]);

  // Live messages for this conversation.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !threadId) return;
    const onMessage = (m: ChatMessageDto) => {
      if (m.threadId === threadId) merge([m]);
    };
    socket.on(RealtimeEvents.MESSAGE, onMessage);
    return () => {
      socket.off(RealtimeEvents.MESSAGE, onMessage);
    };
  }, [threadId, merge]);

  /** The page just older than the oldest message shown. */
  const loadOlder = useCallback(async () => {
    const oldest = oldestStored(listRef.current);
    if (!threadId || !oldest || loadingOlder) return 0;
    setLoadingOlder(true);
    try {
      const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`, {
        params: { before: oldest.id },
      });
      merge(data);
      setHasOlder(data.length >= PAGE);
      return data.length;
    } catch (e) {
      setError(e);
      return 0;
    } finally {
      setLoadingOlder(false);
    }
  }, [threadId, loadingOlder, merge]);

  const post = useCallback(
    async (clientMessageId: string): Promise<string | null> => {
      const send = sendsRef.current.get(clientMessageId);
      if (!send) return null;
      setMessages((prev) => setLocalStatus(prev, clientMessageId, 'sending'));
      try {
        const { data } = await api.post<{ message: ChatMessageDto; threadId: string }>(
          '/chat/messages',
          { ...send.target, body: send.body, replyToId: send.replyToId, clientMessageId },
        );
        sendsRef.current.delete(clientMessageId);
        merge([data.message]);
        return data.threadId;
      } catch {
        setMessages((prev) => setLocalStatus(prev, clientMessageId, 'failed'));
        return null;
      }
    },
    [merge],
  );

  /** Show the message at once, then store it. Resolves to the conversation id. */
  const send = useCallback(
    (target: SendTarget, input: SendInput) => {
      const clientMessageId = crypto.randomUUID();
      const body = input.body.trim();
      sendsRef.current.set(clientMessageId, { target, body, replyToId: input.replyTo?.id });
      const bubble: LocalMessage = {
        id: localId(clientMessageId),
        threadId: threadId ?? '',
        senderId: me.id,
        senderName: me.name,
        senderRole: me.role,
        body,
        readAt: null,
        createdAt: new Date().toISOString(),
        mine: true,
        clientMessageId,
        status: 'sending',
        replyTo: input.replyTo
          ? {
              id: input.replyTo.id,
              senderName: input.replyTo.senderName,
              body: input.replyTo.body,
              isVoice: !!input.replyTo.audio,
            }
          : null,
      };
      setMessages((prev) => [...prev, bubble]);
      return post(clientMessageId);
    },
    [threadId, me.id, me.name, me.role, post],
  );

  /** Send a failed message again — same client id, so it cannot land twice. */
  const retry = useCallback((clientMessageId: string) => post(clientMessageId), [post]);

  /** Drop a failed message the writer gave up on. */
  const discard = useCallback((clientMessageId: string) => {
    sendsRef.current.delete(clientMessageId);
    setMessages((prev) => prev.filter((m) => m.id !== localId(clientMessageId)));
  }, []);

  /** For a message stored outside `send` (a voice note). */
  const add = useCallback((m: ChatMessageDto) => merge([m]), [merge]);

  const reset = useCallback(() => setMessages([]), []);

  return {
    messages,
    loaded,
    error,
    hasOlder,
    loadingOlder,
    loadOlder,
    send,
    retry,
    discard,
    add,
    reset,
  };
}

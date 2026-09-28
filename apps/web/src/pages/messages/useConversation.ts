import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChatAttachmentDto,
  ChatMessageDto,
  ChatReactionDto,
  ChatReactionEvent,
  ChatSeenEvent,
  RealtimeEvents,
} from '@darsly/shared-types';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import {
  applyReactions,
  applySeen,
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
/** A catch-up page; fewer than this means we have reached the newest message. */
const CATCH_UP = 100;

/**
 * Who a message goes to: an existing conversation, or a person the caller may
 * start one with. The conversation is created by the server with the first
 * message — never by opening the page, and never by attaching a file.
 */
/**
 * Who a send is for: a conversation, or a person — a student (from staff; with
 * the academy when it is not the sender's own workspace), a teacher (from a
 * student), or an assistant the academy made reachable (from a student).
 */
export type SendTarget =
  | { threadId: string }
  | { studentId: string; academyId?: string }
  | { tenantId: string }
  | { staffUserId: string; academyId: string };

export interface SendInput {
  body: string;
  replyTo?: ChatMessageDto | null;
  attachments?: ChatAttachmentDto[];
}

/**
 * One open conversation's messages.
 *
 * - Opens on the NEWEST page; `loadOlder` pages back by keyset on the oldest
 *   message shown, so nothing is skipped or repeated while messages arrive.
 * - `jumpTo` loads a window around a message that is not loaded yet (a quoted
 *   original deep in history); `jumpToLatest` returns to the newest page.
 * - Stays current through one merge fed by the socket (messages, reactions,
 *   read positions), a poll for anything newer than the newest message shown,
 *   a catch-up on reconnect, and each send's own response.
 * - Sends carry a clientMessageId: the bubble shows at once, a failure stays
 *   on screen with Retry, and a retry cannot be stored twice.
 */
export function useConversation(
  threadId: string | null,
  me: { id: string; name: string; role: ChatMessageDto['senderRole'] },
) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loaded, setLoaded] = useState(!threadId);
  const [hasOlder, setHasOlder] = useState(false);
  /** Showing a window in the past: newer messages exist below what is loaded. */
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const listRef = useRef<LocalMessage[]>([]);
  listRef.current = messages;
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
  const sendsRef = useRef(
    new Map<
      string,
      { target: SendTarget; body: string; replyToId?: string; attachmentIds: string[] }
    >(),
  );

  const merge = useCallback((incoming: ChatMessageDto[]) => {
    setMessages((prev) => mergeMessages(prev, incoming));
  }, []);

  const loadNewest = useCallback(async () => {
    if (!threadId) return;
    const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`);
    setMessages((prev) =>
      // Keep only sends still in flight; the page is the truth for the rest.
      mergeMessages(
        prev.filter((m) => m.status),
        data,
      ),
    );
    setHasOlder(data.length >= PAGE);
    setHasNewer(false);
  }, [threadId]);

  // Opening a conversation: its newest page. Moving from "no conversation yet"
  // to the one the first send created keeps what is already on screen.
  useEffect(() => {
    let cancelled = false;
    setMessages((prev) => (threadId ? prev.filter((m) => m.threadId === threadId) : []));
    setError(null);
    setHasOlder(false);
    setHasNewer(false);
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

  /**
   * What is new since the newest message shown. Also how a window in the past
   * fills forward. A cursor the server no longer knows (the conversation was
   * cleared) falls back to the newest page.
   */
  const catchUp = useCallback(async () => {
    if (!threadId) return;
    const newest = newestStored(listRef.current);
    try {
      const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`, {
        params: newest ? { after: newest.id, limit: CATCH_UP } : {},
      });
      merge(data);
      if (data.length < CATCH_UP) setHasNewer(false);
    } catch (e: any) {
      if (e?.response?.data?.code === 'CURSOR_UNKNOWN') await loadNewest().catch(() => undefined);
    }
  }, [threadId, merge, loadNewest]);

  useEffect(() => {
    if (!threadId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !hasNewerRef.current) void catchUp();
    }, POLL_MS);
    const onFocus = () => void catchUp();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [threadId, catchUp]);

  /** Tell the server "read" soon after a message arrives while the reader is looking. */
  const readTimer = useRef<number>();
  const markReadSoon = useCallback(() => {
    if (!threadId || document.visibilityState !== 'visible') return;
    window.clearTimeout(readTimer.current);
    readTimer.current = window.setTimeout(() => {
      void api.post(`/chat/threads/${threadId}/read`, {}).catch(() => undefined);
    }, 600);
  }, [threadId]);
  useEffect(() => () => window.clearTimeout(readTimer.current), []);

  // Live: messages, reactions, read positions — and a catch-up after reconnect.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !threadId) return;
    const onMessage = (m: ChatMessageDto) => {
      if (m.threadId !== threadId) return;
      // In a window in the past, a new message belongs below the gap, not here.
      if (hasNewerRef.current && !m.mine) return;
      merge([m]);
      if (!m.mine) markReadSoon();
    };
    const onReaction = (e: ChatReactionEvent) => {
      if (e.threadId === threadId)
        setMessages((prev) => applyReactions(prev, e.messageId, e.reactions));
    };
    const onSeen = (e: ChatSeenEvent) => {
      if (e.threadId === threadId && e.userId !== me.id)
        setMessages((prev) => applySeen(prev, e.lastReadAt));
    };
    const onReconnect = () => void catchUp();
    socket.on(RealtimeEvents.MESSAGE, onMessage);
    socket.on(RealtimeEvents.REACTION, onReaction);
    socket.on(RealtimeEvents.SEEN, onSeen);
    socket.on('connect', onReconnect);
    return () => {
      socket.off(RealtimeEvents.MESSAGE, onMessage);
      socket.off(RealtimeEvents.REACTION, onReaction);
      socket.off(RealtimeEvents.SEEN, onSeen);
      socket.off('connect', onReconnect);
    };
  }, [threadId, merge, me.id, catchUp, markReadSoon]);

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

  /**
   * Make a message available to scroll to. Already loaded → nothing to do.
   * Otherwise load a window around it (the reader lands in the past, with a
   * way back to the latest). Resolves false when it cannot be shown.
   */
  const jumpTo = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (listRef.current.some((m) => m.id === messageId)) return true;
      if (!threadId) return false;
      try {
        const { data } = await api.get<ChatMessageDto[]>(`/chat/threads/${threadId}/messages`, {
          params: { around: messageId },
        });
        if (!data.some((m) => m.id === messageId)) return false;
        setMessages(mergeMessages([], data));
        setHasOlder(true);
        setHasNewer(true);
        return true;
      } catch {
        return false;
      }
    },
    [threadId],
  );

  const jumpToLatest = useCallback(() => loadNewest().catch(() => undefined), [loadNewest]);

  const post = useCallback(
    async (clientMessageId: string): Promise<string | null> => {
      const send = sendsRef.current.get(clientMessageId);
      if (!send) return null;
      setMessages((prev) => setLocalStatus(prev, clientMessageId, 'sending'));
      try {
        const { data } = await api.post<{ message: ChatMessageDto; threadId: string }>(
          '/chat/messages',
          {
            ...send.target,
            body: send.body,
            replyToId: send.replyToId,
            clientMessageId,
            ...(send.attachmentIds.length ? { attachmentIds: send.attachmentIds } : {}),
          },
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
      const attachments = input.attachments ?? [];
      sendsRef.current.set(clientMessageId, {
        target,
        body,
        replyToId: input.replyTo?.id,
        attachmentIds: attachments.map((a) => a.id),
      });
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
        attachments,
        reactions: [],
        replyTo: input.replyTo
          ? {
              id: input.replyTo.id,
              senderName: input.replyTo.senderName,
              body: input.replyTo.body,
              isVoice: !!input.replyTo.audio,
              attachmentKind: input.replyTo.attachments?.[0]?.kind ?? null,
            }
          : null,
      };
      // A send made from a window in the past brings the reader back to now.
      if (hasNewerRef.current) void loadNewest().catch(() => undefined);
      setMessages((prev) => [...prev, bubble]);
      return post(clientMessageId);
    },
    [threadId, me.id, me.name, me.role, post, loadNewest],
  );

  /** Send a failed message again — same client id, so it cannot land twice. */
  const retry = useCallback((clientMessageId: string) => post(clientMessageId), [post]);

  /** Drop a failed message the writer gave up on. */
  const discard = useCallback((clientMessageId: string) => {
    sendsRef.current.delete(clientMessageId);
    setMessages((prev) => prev.filter((m) => m.id !== localId(clientMessageId)));
  }, []);

  /**
   * React (or, with null, take my reaction back). Shown at once; the server's
   * answer — and everyone else's push — then settles the counts.
   */
  const react = useCallback(
    async (messageId: string, emoji: string | null) => {
      const current = listRef.current.find((m) => m.id === messageId);
      if (!current) return;
      setMessages((prev) =>
        applyReactions(prev, messageId, optimistic(current.reactions ?? [], emoji, me.name)),
      );
      try {
        const { data } = emoji
          ? await api.put<ChatReactionDto[]>(`/chat/messages/${messageId}/reaction`, { emoji })
          : await api.delete<ChatReactionDto[]>(`/chat/messages/${messageId}/reaction`);
        setMessages((prev) => applyReactions(prev, messageId, data));
      } catch {
        setMessages((prev) => applyReactions(prev, messageId, current.reactions ?? []));
      }
    },
    [me.name],
  );

  /** For a message stored outside `send` (a voice note). */
  const add = useCallback((m: ChatMessageDto) => merge([m]), [merge]);

  const reset = useCallback(() => setMessages([]), []);

  return {
    messages,
    loaded,
    error,
    hasOlder,
    hasNewer,
    loadingOlder,
    loadOlder,
    jumpTo,
    jumpToLatest,
    send,
    retry,
    discard,
    react,
    markReadSoon,
    add,
    reset,
  };
}

/** My reaction changed: move my count from the old emoji to the new one. */
export function optimistic(
  reactions: ChatReactionDto[],
  emoji: string | null,
  myName: string,
): ChatReactionDto[] {
  const without = reactions
    .map((r) =>
      r.mine
        ? { ...r, count: r.count - 1, mine: false, names: r.names.filter((n) => n !== myName) }
        : r,
    )
    .filter((r) => r.count > 0);
  if (!emoji) return without;
  const hit = without.find((r) => r.emoji === emoji);
  if (hit) {
    return without.map((r) =>
      r.emoji === emoji ? { ...r, count: r.count + 1, mine: true, names: [...r.names, myName] } : r,
    );
  }
  return [...without, { emoji, count: 1, mine: true, names: [myName] }];
}

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessageDto, ChatSenderKind, RealtimeEvents, Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { useAuthStore } from '../../stores/auth';
import Avatar from '../../components/Avatar';
import { Spinner } from '../../components/ui';
import { errorMessage } from '../../lib/errorMessage';
import { dayKey, dayLabel, runPositions } from './format';
import { MessageBubble, roleKey } from './MessageBubble';
import Composer from './Composer';
import { SendTarget, useConversation } from './useConversation';
import { useUploads } from './useUploads';
import type { LocalMessage } from './messageList';

/** Within this distance of the bottom, the reader is "at the latest message". */
const NEAR_BOTTOM_PX = 120;
/** Typing is announced at most this often. */
const TYPING_EVERY_MS = 3000;

export interface ConversationHeader {
  name: string;
  avatarUrl: string | null;
  /** The counterpart's id, for their avatar colour. */
  personId: string | null;
  kind: ChatSenderKind | null;
  /** The viewer's read position when the conversation was opened (unread divider). */
  myLastReadAt: string | null;
}

export default function Conversation({
  threadId,
  target,
  header,
  onBack,
  onThreadCreated,
  onClear,
  onActivity,
}: {
  threadId: string | null;
  target: SendTarget;
  header: ConversationHeader;
  onBack: () => void;
  onThreadCreated: (threadId: string) => void;
  onClear: (() => void) | null;
  onActivity: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const user = useAuthStore((s) => s.user);
  const conv = useConversation(threadId, {
    id: user?.id ?? '',
    name: user?.fullName ?? '',
    role: (user?.role ?? Role.STUDENT) as ChatMessageDto['senderRole'],
  });
  const uploads = useUploads(target, {
    tooLarge: t('messages.fileTooLarge'),
    badType: t('messages.fileBadType'),
    tooMany: t('messages.tooManyFiles'),
    failed: t('messages.uploadFailed'),
  });

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessageDto | null>(null);
  const [notice, setNotice] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [scrolledUp, setScrolledUp] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Reset per conversation.
  useEffect(() => {
    setReplyTo(null);
    setNotice('');
    setPeerTyping(false);
    setNewCount(0);
  }, [threadId]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Join the conversation's room (typing) while it is open.
  useEffect(() => {
    if (!threadId) return;
    const socket = getSocket();
    socket?.emit(RealtimeEvents.JOIN_THREAD, threadId);
    const onTyping = (p: { threadId: string; userId: string }) => {
      if (p.threadId !== threadId || p.userId === user?.id) return;
      setPeerTyping(true);
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setPeerTyping(false), 3500);
    };
    socket?.on(RealtimeEvents.TYPING_ECHO, onTyping);
    return () => {
      socket?.emit(RealtimeEvents.LEAVE_THREAD, threadId);
      socket?.off(RealtimeEvents.TYPING_ECHO, onTyping);
    };
  }, [threadId, user?.id]);
  const typingTimer = useRef<number>();
  const lastTypingSent = useRef(0);
  const onType = useCallback(() => {
    if (!threadId) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_EVERY_MS) return;
    lastTypingSent.current = now;
    getSocket()?.emit(RealtimeEvents.TYPING, threadId);
  }, [threadId]);

  /* ── The unread divider: where the reader stopped, frozen for this visit ─ */
  const openedAt = useRef<{ thread: string | null; readAt: string | null }>({
    thread: null,
    readAt: null,
  });
  if (openedAt.current.thread !== (threadId ?? 'draft')) {
    openedAt.current = { thread: threadId ?? 'draft', readAt: header.myLastReadAt };
  }
  const dividerBefore = useMemo(() => {
    const readAt = openedAt.current.readAt;
    const first = conv.messages.find(
      (m) => !m.mine && !m.status && (!readAt || new Date(m.createdAt) > new Date(readAt)),
    );
    // Nothing unread, or everything is unread and it is the very first page.
    if (!first || (!readAt && first === conv.messages[0])) return null;
    return first.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages, threadId]);

  /* ── Scrolling ───────────────────────────────────────────────────────── */
  const nearBottom = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const openedFor = useRef<string | null>(null);
  const forceBottom = useRef(false);
  const lastSeenCount = useRef(0);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    nearBottom.current = true;
    setNewCount(0);
    setScrolledUp(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    nearBottom.current = near;
    setScrolledUp(!near);
    if (near && !conv.hasNewer) setNewCount(0);
    if (el.scrollTop < 120 && conv.hasOlder && !conv.loadingOlder && conv.loaded) {
      prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      void conv.loadOlder().then((n) => {
        if (!n) prepend.current = null;
      });
    }
  }, [conv]);

  const lastMessage = conv.messages[conv.messages.length - 1];
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // "Go to the newest" beats "keep my place": when the list was replaced
    // (back to latest, my own send from history) an older-page anchor taken a
    // moment earlier no longer describes anything on screen.
    if (forceBottom.current && conv.loaded) {
      forceBottom.current = false;
      prepend.current = null;
      lastSeenCount.current = conv.messages.length;
      toBottom();
      return;
    }
    if (prepend.current) {
      el.scrollTop = el.scrollHeight - prepend.current.height + prepend.current.top;
      prepend.current = null;
      return;
    }
    const key = threadId ?? 'draft';
    if (openedFor.current !== key && conv.loaded) {
      openedFor.current = key;
      lastSeenCount.current = conv.messages.length;
      const divider = dividerBefore ? document.getElementById(`msg-${dividerBefore}`) : null;
      if (divider) {
        el.scrollTop = Math.max(0, divider.offsetTop - el.clientHeight / 3);
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      } else toBottom();
      return;
    }
    const grew = conv.messages.length > lastSeenCount.current;
    lastSeenCount.current = conv.messages.length;
    if (lastMessage?.mine && lastMessage.status === 'sending') {
      toBottom();
    } else if (nearBottom.current && !conv.hasNewer) {
      el.scrollTop = el.scrollHeight;
    } else if (grew && lastMessage && !lastMessage.mine) {
      setNewCount((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.messages, conv.loaded, threadId, peerTyping]);

  /** Jump to a quoted message: load it if needed, centre it, flash it. */
  const jumpToQuote = useCallback(
    async (id: string) => {
      prepend.current = null;
      const ok = await conv.jumpTo(id);
      if (!ok) {
        setNotice(t('messages.unavailable'));
        return;
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document
            .getElementById(`msg-${id}`)
            ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setHighlight(id);
          window.setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1800);
        }),
      );
    },
    [conv, t],
  );

  const goLatest = useCallback(async () => {
    if (conv.hasNewer) {
      forceBottom.current = true;
      await conv.jumpToLatest();
    } else toBottom(true);
  }, [conv, toBottom]);

  /* ── Sending ─────────────────────────────────────────────────────────── */
  const send = useCallback(async () => {
    const body = draft.trim();
    const attachments = uploads.doneAttachments;
    if ((!body && !attachments.length) || uploads.busy) return;
    setDraft('');
    uploads.clear();
    const quoted = replyTo;
    setReplyTo(null);
    forceBottom.current = true;
    const tid = await conv.send(target, { body, replyTo: quoted, attachments });
    if (tid && !threadId) onThreadCreated(tid);
    onActivity();
    inputRef.current?.focus();
  }, [draft, uploads, replyTo, conv, target, threadId, onThreadCreated, onActivity]);

  const sendVoice = useCallback(
    async (blob: Blob, seconds: number) => {
      if (!threadId) return;
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      fd.append('durationSec', String(seconds));
      if (replyTo) fd.append('replyToId', replyTo.id);
      setReplyTo(null);
      try {
        const { data } = await api.post(`/chat/threads/${threadId}/voice`, fd);
        forceBottom.current = true;
        conv.add(data.message);
        onActivity();
      } catch {
        setNotice(t('messages.voiceFailed'));
      }
    },
    [threadId, replyTo, conv, onActivity, t],
  );

  const onReply = useCallback((m: LocalMessage) => {
    setReplyTo(m);
    inputRef.current?.focus();
  }, []);
  const onCopied = useCallback(() => setNotice(t('messages.copied')), [t]);

  /* ── Render ──────────────────────────────────────────────────────────── */
  const days = useMemo(() => {
    const out: { day: string; items: LocalMessage[] }[] = [];
    for (const m of conv.messages) {
      const day = dayKey(m.createdAt);
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [conv.messages]);

  const subtitle = peerTyping ? t('messages.typing') : header.kind ? t(roleKey(header.kind)) : '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-container-low/60">
      <header className="flex items-center gap-3 border-b border-outline-variant/40 bg-surface-container-lowest px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4 sm:py-3">
        <button
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high lg:hidden"
          onClick={onBack}
          aria-label={t('messages.backToList')}
        >
          <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
        </button>
        <Avatar id={header.personId} name={header.name} url={header.avatarUrl} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-heading text-base font-bold text-on-surface">
            <bdi>{header.name}</bdi>
          </h2>
          <p
            className={`truncate text-xs ${peerTyping ? 'font-bold text-primary-text' : 'text-on-surface-variant'}`}
            aria-live="polite"
          >
            {subtitle}
          </p>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            title={t('messages.clear')}
            aria-label={t('messages.clear')}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-high"
          >
            <span className="material-symbols-outlined text-[21px]">delete_sweep</span>
          </button>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto overscroll-contain px-3 pb-4 pt-2 sm:px-6"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('messages.conversationWith', { name: header.name })}
        >
          {conv.hasOlder && (
            <div className="flex justify-center py-3">
              {conv.loadingOlder ? (
                <Spinner />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const el = scrollerRef.current;
                    if (el) prepend.current = { height: el.scrollHeight, top: el.scrollTop };
                    void conv.loadOlder();
                  }}
                  className="rounded-full bg-surface-container-lowest px-4 py-1.5 text-xs font-bold text-primary-text shadow-hairline"
                >
                  {t('messages.loadEarlier')}
                </button>
              )}
            </div>
          )}

          {!conv.loaded ? (
            <SkeletonBubbles />
          ) : conv.error && !conv.messages.length ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="material-symbols-outlined text-4xl text-outline">cloud_off</span>
              <p className="text-sm text-on-surface-variant">{errorMessage(conv.error)}</p>
            </div>
          ) : !conv.messages.length ? (
            <EmptyConversation
              name={header.name}
              avatarUrl={header.avatarUrl}
              personId={header.personId}
              hasThread={!!threadId}
              t={t}
            />
          ) : null}

          {days.map(({ day, items }) => {
            const runs = runPositions(items);
            const label = dayLabel(day, lang);
            return (
              <section
                key={day}
                aria-label={label.kind === 'date' ? label.text : t(`messages.${label.kind}`)}
              >
                <div className="sticky top-0 z-10 flex justify-center py-2">
                  <span className="rounded-full bg-surface-container-lowest/95 px-3 py-1 text-xs font-bold text-on-surface-variant shadow-hairline backdrop-blur">
                    {label.kind === 'date' ? label.text : t(`messages.${label.kind}`)}
                  </span>
                </div>
                {items.map((m, i) => (
                  <Fragment key={m.clientMessageId && m.mine ? `c:${m.clientMessageId}` : m.id}>
                    {m.id === dividerBefore && (
                      <div className="my-3 flex items-center gap-3" role="separator">
                        <span className="h-px flex-1 bg-primary/40" />
                        <span className="text-xs font-bold text-primary-text">
                          {t('messages.newMessages')}
                        </span>
                        <span className="h-px flex-1 bg-primary/40" />
                      </div>
                    )}
                    <MessageBubble
                      m={m}
                      run={runs[i]}
                      showSender={!m.mine}
                      highlighted={highlight === m.id}
                      lang={lang}
                      t={t}
                      onReply={onReply}
                      onReact={conv.react}
                      onJumpToQuote={jumpToQuote}
                      onRetry={conv.retry}
                      onDiscard={conv.discard}
                      onCopied={onCopied}
                    />
                  </Fragment>
                ))}
              </section>
            );
          })}
          {peerTyping && (
            <div className="mt-2 flex items-center gap-2 ps-10 text-on-surface-variant" aria-hidden>
              <span className="flex gap-1 rounded-full bg-surface-container-lowest px-3 py-2.5 shadow-hairline">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-outline [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-outline [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-outline" />
              </span>
            </div>
          )}
        </div>

        {(newCount > 0 || conv.hasNewer || scrolledUp) && conv.messages.length > 0 && (
          <button
            type="button"
            onClick={() => void goLatest()}
            className={`absolute bottom-3 end-4 flex h-10 items-center gap-1.5 rounded-full bg-surface-container-lowest shadow-elevated ring-1 ring-outline-variant/40 transition hover:bg-surface-container-high ${
              newCount > 0 || conv.hasNewer
                ? 'px-4 text-sm font-bold text-primary-text'
                : 'w-10 justify-center text-on-surface-variant'
            }`}
            aria-label={
              newCount > 0
                ? t('messages.newCount', { count: newCount })
                : t('messages.jumpToLatest')
            }
          >
            <span className="material-symbols-outlined text-[20px]">arrow_downward</span>
            {newCount > 0
              ? t('messages.newCount', { count: newCount })
              : conv.hasNewer
                ? t('messages.jumpToLatest')
                : null}
          </button>
        )}
      </div>

      {notice && (
        <p
          role="status"
          className="border-t border-outline-variant/40 bg-surface-container-high px-4 py-2 text-center text-sm text-on-surface"
        >
          {notice}
        </p>
      )}

      <Composer
        draft={draft}
        setDraft={setDraft}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        uploads={uploads}
        canRecord={!!threadId}
        onVoice={sendVoice}
        onSend={() => void send()}
        onType={onType}
        onNotice={setNotice}
        inputRef={inputRef}
        lang={lang}
        t={t}
      />
    </div>
  );
}

function EmptyConversation({
  name,
  avatarUrl,
  personId,
  hasThread,
  t,
}: {
  name: string;
  avatarUrl: string | null;
  personId: string | null;
  hasThread: boolean;
  t: (k: string, o?: any) => string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Avatar id={personId} name={name} url={avatarUrl} size={64} />
      <p className="font-heading text-lg font-bold text-on-surface">
        <bdi>{name}</bdi>
      </p>
      <p className="max-w-xs text-sm text-on-surface-variant">
        {hasThread ? t('messages.startHint') : t('messages.startWith', { name })}
      </p>
    </div>
  );
}

function SkeletonBubbles() {
  const rows = [
    { mine: false, w: '55%' },
    { mine: false, w: '35%' },
    { mine: true, w: '45%' },
    { mine: false, w: '60%' },
    { mine: true, w: '30%' },
  ];
  return (
    <div className="flex flex-col gap-3 py-6" aria-hidden>
      {rows.map((r, i) => (
        <div key={i} className={`flex items-end gap-2 ${r.mine ? 'flex-row-reverse' : ''}`}>
          {!r.mine && (
            <span className="h-8 w-8 animate-pulse rounded-full bg-surface-container-high" />
          )}
          <span
            className="h-10 animate-pulse rounded-sm bg-surface-container-high"
            style={{ width: r.w }}
          />
        </div>
      ))}
    </div>
  );
}

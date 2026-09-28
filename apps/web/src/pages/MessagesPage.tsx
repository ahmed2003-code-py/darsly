import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ChatMessageDto, ChatThreadDto, RealtimeEvents, Role } from '@darsly/shared-types';
import { api } from '../lib/api';
import { askConfirm } from '../lib/confirm';
import { errorMessage } from '../lib/errorMessage';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../stores/auth';
import { EmptyState, PageHeader, Spinner } from '../components/ui';
import { LocalMessage } from './messages/messageList';
import { SendTarget, useConversation } from './messages/useConversation';

/** Five minutes, matching the server. A voice note is a thought, not a lecture. */
const VOICE_MAX_SECONDS = 300;
/** Must match the API's default list page (THREAD_PAGE). */
const THREAD_PAGE = 50;
/** Within this distance of the bottom, the reader is "at the latest message". */
const NEAR_BOTTOM_PX = 120;

/** What a conversation's header needs, whether or not the conversation exists yet. */
interface Header {
  name: string;
  avatarUrl: string | null;
  threadId: string | null;
}

export default function MessagesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [params, setParams] = useSearchParams();
  const activeId = params.get('t');
  // Someone with no conversation yet — the console's message button lands here
  // with `?student=`, a student's "message the teacher" with `?teacher=`.
  // Opening this creates nothing; the first message sent does.
  const draftStudent = activeId ? null : params.get('student');
  const draftTeacher = activeId ? null : params.get('teacher');
  const drafting = !!(draftStudent || draftTeacher);

  const [draft, setDraft] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessageDto | null>(null);
  const [notice, setNotice] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number>();

  /**
   * The conversation list, one keyset page at a time. Refreshed on a timer as
   * well as by the socket: a list a minute out of date reads as broken.
   */
  const threadsQuery = useInfiniteQuery({
    queryKey: ['chat-threads', 'pages'],
    queryFn: async ({ pageParam }) =>
      (
        await api.get<ChatThreadDto[]>('/chat/threads', {
          params: pageParam ? { before: pageParam } : {},
        })
      ).data,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length >= THREAD_PAGE ? last[last.length - 1].id : undefined),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const threads = useMemo(() => threadsQuery.data?.pages.flat() ?? [], [threadsQuery.data]);
  const listed = threads.find((th) => th.id === activeId);

  // A conversation that is not on the loaded pages — an old notification, a
  // deep link — still gets its header.
  const { data: fetchedHeader, error: headerError } = useQuery<ChatThreadDto>({
    queryKey: ['chat-thread', activeId],
    queryFn: async () => (await api.get(`/chat/threads/${activeId}`)).data,
    enabled: !!activeId && !listed && threadsQuery.isFetched,
  });

  // Someone with no conversation yet: who they are, and whether one exists
  // after all (then go straight to it).
  const { data: resolved, error: resolveError } = useQuery<{
    threadId: string | null;
    counterpartName: string;
    counterpartAvatarUrl: string | null;
  }>({
    queryKey: ['chat-resolve', draftStudent, draftTeacher],
    queryFn: async () =>
      (
        await api.get('/chat/resolve', {
          params: draftStudent ? { studentId: draftStudent } : { tenantId: draftTeacher },
        })
      ).data,
    enabled: drafting,
  });
  useEffect(() => {
    if (resolved?.threadId) setParams({ t: resolved.threadId }, { replace: true });
  }, [resolved?.threadId, setParams]);

  const headerThread = listed ?? fetchedHeader;
  const header: Header | null = activeId
    ? headerThread
      ? {
          name: headerThread.counterpartName,
          avatarUrl: headerThread.counterpartAvatarUrl,
          threadId: activeId,
        }
      : null
    : drafting && resolved && !resolved.threadId
      ? { name: resolved.counterpartName, avatarUrl: resolved.counterpartAvatarUrl, threadId: null }
      : null;
  const openError = activeId ? headerError : resolveError;
  /** The message scroller is only rendered once there is a header to go above it. */
  const scrollerMounted = !!header && !openError;

  const conv = useConversation(activeId, {
    id: user?.id ?? '',
    name: user?.fullName ?? '',
    role: (user?.role ?? Role.STUDENT) as ChatMessageDto['senderRole'],
  });

  useEffect(() => {
    setReplyTo(null);
    setPeerTyping(false);
    if (!activeId) return;
    const socket = getSocket();
    socket?.emit(RealtimeEvents.JOIN_THREAD, activeId);
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    return () => {
      socket?.emit(RealtimeEvents.LEAVE_THREAD, activeId);
    };
  }, [activeId, queryClient]);

  // Anything new anywhere moves the list; the typing echo is only for this one.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onMessage = () => queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    const onTyping = (p: { threadId: string }) => {
      if (p.threadId === activeId) {
        setPeerTyping(true);
        window.clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => setPeerTyping(false), 2500);
      }
    };
    socket.on(RealtimeEvents.MESSAGE, onMessage);
    socket.on(RealtimeEvents.TYPING_ECHO, onTyping);
    return () => {
      socket.off(RealtimeEvents.MESSAGE, onMessage);
      socket.off(RealtimeEvents.TYPING_ECHO, onTyping);
    };
  }, [activeId, queryClient]);

  /* ── Scrolling ───────────────────────────────────────────────────────────
   * Three rules, so the view never jumps under the reader:
   *  - a conversation opens at its newest message;
   *  - a new message scrolls into view only if the reader was already at the
   *    bottom, or wrote it — someone reading back is left where they are;
   *  - an older page loaded above keeps the message they were looking at in
   *    the same place on screen.
   */
  const nearBottom = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const openedFor = useRef<string | null>(null);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (el.scrollTop < 80 && conv.hasOlder && !conv.loadingOlder) {
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
    if (prepend.current) {
      el.scrollTop = el.scrollHeight - prepend.current.height + prepend.current.top;
      prepend.current = null;
      return;
    }
    const key = activeId ?? 'draft';
    if (openedFor.current !== key && conv.loaded) {
      openedFor.current = key;
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
      return;
    }
    if (nearBottom.current || lastMessage?.mine) el.scrollTop = el.scrollHeight;
    // `scrollerMounted`: the messages and the header arrive from separate
    // requests. When the messages win, the scroller is not on screen yet (the
    // page is still waiting for the header), this effect finds no element and
    // returns — and nothing it depends on changes when the header lands, so the
    // conversation stayed at its oldest loaded message. Mounting is a change.
  }, [conv.messages, conv.loaded, activeId, lastMessage, peerTyping, scrollerMounted]);

  /* ── Sending ─────────────────────────────────────────────────────────── */

  const target: SendTarget | null = activeId
    ? { threadId: activeId }
    : draftStudent
      ? { studentId: draftStudent }
      : draftTeacher
        ? { tenantId: draftTeacher }
        : null;

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !target) return;
    setDraft('');
    const quoted = replyTo;
    setReplyTo(null);
    const threadId = await conv.send(target, { body, replyTo: quoted });
    if (threadId && !activeId) {
      // The first message just created the conversation: from here on the
      // page is that conversation, and back does not return to the draft.
      setParams({ t: threadId }, { replace: true });
    }
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
  }

  /** A recorded clip, sent the moment recording stops. */
  const sendVoice = useCallback(
    async (blob: Blob, seconds: number) => {
      if (!activeId) return;
      const replyToId = replyTo?.id;
      setReplyTo(null);
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      fd.append('durationSec', String(seconds));
      if (replyToId) fd.append('replyToId', replyToId);
      try {
        const { data } = await api.post(`/chat/threads/${activeId}/voice`, fd);
        conv.add(data.message);
      } catch {
        setNotice(t('messages.voiceFailed'));
      }
    },
    [activeId, replyTo, t, conv],
  );

  function onType() {
    if (activeId) getSocket()?.emit(RealtimeEvents.TYPING, activeId);
  }

  /** Take this conversation off my list. The other side keeps theirs. */
  async function clearThread(id: string) {
    if (!(await askConfirm(t('messages.clearConfirm')))) return;
    await api.delete(`/chat/threads/${id}`);
    if (id === activeId) {
      // Emptied on screen at the same moment it is emptied on the server, so
      // there is no window where the cleared messages are still sitting there.
      conv.reset();
      setParams({});
    }
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
  }

  /** Group by day so a long conversation reads as days, not as one wall. */
  const grouped = useMemo(() => groupByDay(conv.messages), [conv.messages]);
  const showConversation = !!(activeId || drafting);

  return (
    <div className="page">
      <PageHeader title={t('messages.title')} subtitle={t('messages.subtitle')} />

      {/* Sized against the viewport so the composer is always on screen and the
          message list scrolls rather than the page. The phone subtracts more
          because the bottom tab bar is sitting under it. */}
      <div className="card flex h-[calc(100dvh-17rem)] min-h-[26rem] overflow-hidden p-0 sm:h-[calc(100dvh-14rem)]">
        {/* Thread list */}
        <div
          className={`w-full border-e border-outline-variant/40 sm:w-80 sm:shrink-0 ${
            showConversation ? 'hidden sm:block' : ''
          }`}
        >
          {threadsQuery.isLoading ? (
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
          ) : !threads.length ? (
            <div className="p-6">
              <EmptyState icon="forum" title={t('messages.empty')} hint={t('messages.emptyHint')} />
            </div>
          ) : (
            <ul className="h-full overflow-y-auto">
              {threads.map((th) => (
                <li key={th.id}>
                  <button
                    onClick={() => setParams({ t: th.id })}
                    className={`flex w-full items-center gap-3 border-b border-outline-variant/30 px-4 py-3 text-start transition hover:bg-surface-container-low ${
                      th.id === activeId ? 'bg-primary-fixed/40' : ''
                    }`}
                  >
                    <Avatar name={th.counterpartName} url={th.counterpartAvatarUrl} rem={2.75} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-bold">{th.counterpartName}</span>
                        {th.lastMessageAt && (
                          <span className="shrink-0 text-xs text-outline" dir="ltr">
                            {shortTime(th.lastMessageAt, i18n.language)}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-on-surface-variant">
                          {th.lastMessage || t('messages.startHint')}
                        </span>
                        {th.unread > 0 && (
                          <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-on-primary">
                            {th.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {threadsQuery.hasNextPage && (
                <li className="p-3 text-center">
                  <button
                    type="button"
                    onClick={() => void threadsQuery.fetchNextPage()}
                    disabled={threadsQuery.isFetchingNextPage}
                    className="text-sm font-bold text-primary disabled:opacity-50"
                  >
                    {t('messages.moreConversations')}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Conversation */}
        <div className={`flex min-w-0 flex-1 flex-col ${showConversation ? '' : 'hidden sm:flex'}`}>
          {!showConversation ? (
            <div className="flex flex-1 items-center justify-center text-outline">
              <div className="text-center">
                <span className="material-symbols-outlined text-5xl text-outline-variant">
                  chat
                </span>
                <p className="mt-2">{t('messages.selectThread')}</p>
              </div>
            </div>
          ) : openError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-on-surface-variant">{errorMessage(openError)}</p>
              <button className="btn-secondary" onClick={() => setParams({})}>
                {t('messages.backToList')}
              </button>
            </div>
          ) : !header ? (
            <div className="grid flex-1 place-items-center">
              <Spinner />
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-outline-variant/40 px-4 py-3 sm:px-5">
                <button
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-outline transition hover:bg-surface-container-high sm:hidden"
                  onClick={() => setParams({})}
                  aria-label={t('common.close')}
                >
                  <span className="material-symbols-outlined rtl:-scale-x-100">arrow_back</span>
                </button>
                <Avatar name={header.name} url={header.avatarUrl} rem={2.5} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading font-bold">{header.name}</p>
                  <p className="truncate text-xs text-on-surface-variant">
                    {peerTyping ? t('messages.typing') : ''}
                  </p>
                </div>
                {header.threadId && (
                  <button
                    onClick={() => void clearThread(header.threadId!)}
                    title={t('messages.clear')}
                    aria-label={t('messages.clear')}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-outline transition hover:bg-error-container hover:text-on-error-container"
                  >
                    <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
                  </button>
                )}
              </header>

              <div
                ref={scrollerRef}
                onScroll={onScroll}
                className="flex-1 space-y-1 overflow-y-auto bg-surface-container-low/40 px-3 py-4 sm:px-5"
              >
                {conv.hasOlder && (
                  <div className="flex justify-center py-2">
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
                        className="text-xs font-bold text-primary"
                      >
                        {t('messages.loadEarlier')}
                      </button>
                    )}
                  </div>
                )}
                {!conv.loaded ? (
                  <div className="grid place-items-center py-10">
                    <Spinner />
                  </div>
                ) : conv.error && !conv.messages.length ? (
                  <p className="py-10 text-center text-sm text-error">{errorMessage(conv.error)}</p>
                ) : !conv.messages.length ? (
                  // No conversation yet is a normal state, not an error: say
                  // who this will reach and put the cursor in the composer.
                  <p className="py-10 text-center text-sm text-on-surface-variant">
                    {header.threadId
                      ? t('messages.startHint')
                      : t('messages.startWith', { name: header.name })}
                  </p>
                ) : null}
                {grouped.map(({ day, items }) => (
                  <div key={day} className="space-y-1">
                    <p className="sticky top-0 z-10 mx-auto my-3 w-fit rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-on-surface-variant">
                      {dayLabel(day, t, i18n.language)}
                    </p>
                    {items.map((m, i) => (
                      <Bubble
                        key={m.clientMessageId && m.mine ? `c:${m.clientMessageId}` : m.id}
                        m={m}
                        // Only the last of a run shows a tail and a timestamp,
                        // so three quick messages read as one turn, not three.
                        last={i === items.length - 1 || items[i + 1]?.mine !== m.mine}
                        onReply={() => {
                          setReplyTo(m);
                          inputRef.current?.focus();
                        }}
                        onRetry={() => m.clientMessageId && void conv.retry(m.clientMessageId)}
                        onDiscard={() => m.clientMessageId && conv.discard(m.clientMessageId)}
                        t={t}
                        lang={i18n.language}
                      />
                    ))}
                  </div>
                ))}
              </div>

              {notice && (
                <p className="border-t border-error/20 bg-error-container px-4 py-2 text-sm text-on-error-container">
                  {notice}
                </p>
              )}

              {replyTo && (
                <div className="flex items-center gap-3 border-t border-outline-variant/40 bg-surface-container-low px-4 py-2">
                  <span className="h-8 w-1 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-primary">
                      {t('messages.replyingTo', {
                        name: replyTo.mine ? t('messages.you') : replyTo.senderName,
                      })}
                    </span>
                    <span className="block truncate text-sm text-on-surface-variant">
                      {replyTo.audio ? `🎤 ${t('messages.voiceNote')}` : replyTo.body}
                    </span>
                  </span>
                  <button
                    onClick={() => setReplyTo(null)}
                    aria-label={t('messages.cancelReply')}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-outline transition hover:bg-surface-container-high"
                  >
                    <span className="material-symbols-outlined text-[20px]">close</span>
                  </button>
                </div>
              )}

              <Composer
                draft={draft}
                setDraft={setDraft}
                onType={onType}
                onSubmit={send}
                // A voice note is uploaded into a conversation, so it waits
                // until the first written message has created one.
                onVoice={header.threadId ? sendVoice : null}
                onNotice={setNotice}
                inputRef={inputRef}
                t={t}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Pieces ────────────────────────────────────────────────────────────────── */

/** Sized inline rather than by class: Tailwind only ships the classes it can
 *  see in the source, and `h-${size}` is not one of them. */
function Avatar({ name, url, rem }: { name: string; url?: string | null; rem: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed"
      style={{ height: `${rem}rem`, width: `${rem}rem` }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        (name?.trim()?.charAt(0) ?? '؟')
      )}
    </span>
  );
}

/**
 * One message.
 *
 * Everything a person does to a message — answer it, play it — hangs off the
 * bubble itself rather than a menu somewhere else, because on a phone the
 * bubble is the only thing they can aim at.
 */
function Bubble({
  m,
  last,
  onReply,
  onRetry,
  onDiscard,
  t,
  lang,
}: {
  m: LocalMessage;
  last: boolean;
  onReply: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  t: (k: string, o?: any) => string;
  lang: string;
}) {
  // A send that did not reach the server stays on screen, marked, with a way
  // to try again — never silently dropped, and never sent twice (the retry
  // reuses the same client id).
  if (m.status === 'failed') {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="max-w-[78%] rounded-2xl rounded-bs-sm bg-error-container px-3.5 py-2 text-on-error-container shadow-hairline sm:max-w-[70%]">
          <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        </div>
        <p className="flex items-center gap-3 text-xs">
          <span className="text-error">{t('messages.sendFailed')}</span>
          <button type="button" onClick={onRetry} className="font-bold text-primary">
            {t('messages.retry')}
          </button>
          <button type="button" onClick={onDiscard} className="text-on-surface-variant">
            {t('messages.discard')}
          </button>
        </p>
      </div>
    );
  }
  return (
    <div className={`group/msg flex items-end gap-1 ${m.mine ? 'flex-row' : 'flex-row-reverse'}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2 shadow-hairline sm:max-w-[70%] ${
          m.mine
            ? `bg-primary-container text-on-primary ${last ? 'rounded-bs-sm' : ''}`
            : `bg-surface-container-lowest text-on-surface ${last ? 'rounded-be-sm' : ''}`
        }`}
      >
        {m.replyTo && (
          <div
            className={`mb-1.5 rounded-lg border-s-[3px] px-2 py-1 text-xs ${
              m.mine
                ? 'border-on-primary/50 bg-black/10 text-on-primary/85'
                : 'border-primary bg-primary-fixed/40 text-on-surface-variant'
            }`}
          >
            <span className="block font-bold">{m.replyTo.senderName}</span>
            <span className="line-clamp-2 break-words">
              {m.replyTo.isVoice ? `🎤 ${t('messages.voiceNote')}` : m.replyTo.body}
            </span>
          </div>
        )}

        {/* Which lesson the question is about. It used to be the whole reason
            for a second conversation with the same teacher; it is a line on the
            message now. */}
        {m.lesson && (
          <p
            className={`mb-1.5 flex items-center gap-1 text-xs font-bold ${
              m.mine ? 'text-on-primary/85' : 'text-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">play_lesson</span>
            <span className="truncate">{m.lesson.title}</span>
            {m.lesson.atSec != null && <span dir="ltr">· {clock(m.lesson.atSec)}</span>}
          </p>
        )}

        {m.audio ? (
          <VoiceBubble id={m.id} seconds={m.audio.durationSec} mine={!!m.mine} t={t} />
        ) : m.body ? (
          <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
        ) : (
          // A message this build does not know how to draw — a newer kind sent
          // to an older tab. Saying so beats an empty bubble.
          <p className={`text-sm italic ${m.mine ? 'text-on-primary/70' : 'text-outline'}`}>
            {t('messages.unsupported')}
          </p>
        )}

        {last && (
          <p
            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              m.mine ? 'text-on-primary/70' : 'text-outline'
            }`}
            dir="ltr"
          >
            {shortTime(m.createdAt, lang)}
            {m.mine && (
              <span
                className="material-symbols-outlined text-[13px]"
                aria-label={m.status === 'sending' ? t('messages.sending') : undefined}
              >
                {m.status === 'sending' ? 'schedule' : m.readAt ? 'done_all' : 'done'}
              </span>
            )}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onReply}
        title={t('messages.reply')}
        aria-label={t('messages.reply')}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-outline opacity-0 transition hover:bg-surface-container-high hover:text-primary focus-visible:opacity-100 group-hover/msg:opacity-100 max-sm:opacity-60"
      >
        <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">reply</span>
      </button>
    </div>
  );
}

/**
 * A voice note, played in place.
 *
 * The audio is private, so it cannot be an `<audio src>` the browser fetches on
 * its own — there is no way to attach the bearer token to that request. It is
 * fetched once, on the first press, and kept as an object URL for the rest of
 * the visit.
 */
function VoiceBubble({
  id,
  seconds,
  mine,
  t,
}: {
  id: string;
  seconds: number;
  mine: boolean;
  t: (k: string, o?: any) => string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  async function toggle() {
    if (audioRef.current) {
      if (playing) audioRef.current.pause();
      else audioRef.current.play().catch(() => setFailed(true));
      return;
    }
    try {
      const { data } = await api.get(`/chat/messages/${id}/voice`, { responseType: 'blob' });
      const objectUrl = URL.createObjectURL(data);
      setUrl(objectUrl);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.onplay = () => setPlaying(true);
      audio.onpause = () => setPlaying(false);
      audio.onended = () => {
        setPlaying(false);
        setAt(0);
      };
      audio.ontimeupdate = () => setAt(audio.currentTime);
      await audio.play();
    } catch {
      setFailed(true);
    }
  }

  const pct = seconds > 0 ? Math.min(100, (at / seconds) * 100) : 0;
  return (
    <span className="flex items-center gap-2.5 py-0.5">
      <button
        type="button"
        onClick={toggle}
        aria-label={t('messages.voiceNote')}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
          mine ? 'bg-black/15 text-on-primary' : 'bg-primary-fixed text-on-primary-fixed'
        }`}
      >
        <span className="material-symbols-outlined text-[20px]">
          {failed ? 'error' : playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <span className="flex min-w-[7rem] flex-1 flex-col gap-1">
        <span
          className={`h-1.5 overflow-hidden rounded-full ${mine ? 'bg-black/20' : 'bg-surface-container-high'}`}
        >
          <span
            className={`block h-full rounded-full transition-[width] ${mine ? 'bg-on-primary/80' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className={`text-[11px] ${mine ? 'text-on-primary/75' : 'text-outline'}`} dir="ltr">
          {failed ? t('messages.playbackFailed') : clock(playing || at > 0 ? at : seconds)}
        </span>
      </span>
    </span>
  );
}

/**
 * The composer, which is either a text field or a running recorder.
 *
 * They share the row rather than sitting side by side: while a voice note is
 * being recorded there is nothing to type, and the only two things worth
 * offering are send and discard.
 */
function Composer({
  draft,
  setDraft,
  onType,
  onSubmit,
  onVoice,
  onNotice,
  inputRef,
  t,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onType: () => void;
  onSubmit: (e: FormEvent) => void;
  /** null while there is no conversation to upload into yet */
  onVoice: ((blob: Blob, seconds: number) => void) | null;
  onNotice: (m: string) => void;
  inputRef: React.RefObject<HTMLInputElement>;
  t: (k: string, o?: any) => string;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Read by the recorder's `onstop` and by the interval, both of which run
  // outside React's render and would otherwise see a stale `elapsed`.
  const elapsedRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const keepRef = useRef(true);
  const tickRef = useRef<number>();

  const stopTracks = () => recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());

  useEffect(
    () => () => {
      window.clearInterval(tickRef.current);
      stopTracks();
    },
    [],
  );

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onNotice(t('messages.micUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      keepRef.current = true;
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        window.clearInterval(tickRef.current);
        stopTracks();
        const seconds = elapsedRef.current;
        setRecording(false);
        setElapsed(0);
        if (!keepRef.current || seconds < 1 || !onVoice) return;
        onVoice(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }), seconds);
      };
      recorder.start();
      setRecording(true);
      elapsedRef.current = 0;
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
        // Stops itself at the cap rather than recording something the server
        // will refuse after the upload.
        if (elapsedRef.current >= VOICE_MAX_SECONDS) finish(true);
      }, 1000);
    } catch {
      onNotice(t('messages.micDenied'));
    }
  }

  function finish(keep: boolean) {
    keepRef.current = keep;
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else {
      window.clearInterval(tickRef.current);
      setRecording(false);
    }
  }

  if (recording) {
    return (
      <div className="flex items-center gap-3 border-t border-outline-variant/40 p-3">
        <button
          type="button"
          onClick={() => finish(false)}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-error transition hover:bg-error-container"
          aria-label={t('messages.cancelRecording')}
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
        <span className="flex flex-1 items-center gap-2 text-sm font-bold text-error">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-error" />
          {t('messages.recording')}
          <span dir="ltr" className="tabular-nums text-on-surface-variant">
            {clock(elapsed)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => finish(true)}
          className="btn-primary h-11 px-5"
          aria-label={t('messages.stopAndSend')}
        >
          <span className="material-symbols-outlined rtl:-scale-x-100">send</span>
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-2 border-t border-outline-variant/40 p-3"
    >
      <input
        ref={inputRef}
        className="input py-2.5"
        placeholder={t('messages.typePlaceholder')}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onType();
        }}
      />
      {draft.trim() || !onVoice ? (
        <button
          className="btn-primary h-11 px-5"
          aria-label={t('messages.send')}
          disabled={!draft.trim()}
        >
          <span className="material-symbols-outlined rtl:-scale-x-100">send</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed transition hover:bg-primary hover:text-on-primary"
          aria-label={t('messages.record')}
          title={t('messages.record')}
        >
          <span className="material-symbols-outlined">mic</span>
        </button>
      )}
    </form>
  );
}

/* ── Formatting ────────────────────────────────────────────────────────────── */

function shortTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Local calendar day, so "today" means the reader's today. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function groupByDay(messages: ChatMessageDto[]): { day: string; items: ChatMessageDto[] }[] {
  const out: { day: string; items: ChatMessageDto[] }[] = [];
  for (const m of messages) {
    const day = dayKey(m.createdAt);
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push(m);
    else out.push({ day, items: [m] });
  }
  return out;
}

function dayLabel(day: string, t: (k: string) => string, lang: string): string {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (day === today) return t('messages.today');
  if (day === yesterday) return t('messages.yesterday');
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    day: 'numeric',
    month: 'long',
  });
}

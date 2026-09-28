import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ChatSenderKind, ChatThreadDto, RealtimeEvents } from '@darsly/shared-types';
import { api } from '../lib/api';
import { askConfirm } from '../lib/confirm';
import { errorMessage } from '../lib/errorMessage';
import { getSocket } from '../lib/socket';
import { PageHeader, Spinner } from '../components/ui';
import ConversationList from './messages/ConversationList';
import Conversation, { ConversationHeader } from './messages/Conversation';
import type { SendTarget } from './messages/useConversation';

/** Must match the API's default list page (THREAD_PAGE). */
const THREAD_PAGE = 50;

/**
 * The visible viewport, for the phone's full-screen conversation: when the
 * on-screen keyboard opens, the layer shrinks with it so the composer stays
 * right above the keyboard instead of behind it.
 */
function useVisualViewport(active: boolean) {
  const [box, setBox] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const update = () => setBox({ height: vv.height, top: vv.offsetTop });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return box;
}

const useIsDesktop = () => {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
};

export default function MessagesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('t');
  // Someone with no conversation yet — the console's message button lands here
  // with `?student=`, a student's "message the teacher" with `?teacher=`.
  // Opening this creates nothing; the first message sent does.
  const draftStudent = activeId ? null : params.get('student');
  const draftTeacher = activeId ? null : params.get('teacher');
  const drafting = !!(draftStudent || draftTeacher);
  const showConversation = !!(activeId || drafting);
  const desktop = useIsDesktop();

  /** The conversation list, one keyset page at a time. */
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
    refetchInterval: 15_000,
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

  const { data: resolved, error: resolveError } = useQuery<{
    threadId: string | null;
    counterpartName: string;
    counterpartAvatarUrl: string | null;
    counterpartKind: ChatSenderKind;
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

  // Anything new anywhere moves the list.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    socket.on(RealtimeEvents.MESSAGE, refresh);
    socket.on(RealtimeEvents.SEEN, refresh);
    return () => {
      socket.off(RealtimeEvents.MESSAGE, refresh);
      socket.off(RealtimeEvents.SEEN, refresh);
    };
  }, [queryClient]);
  useEffect(() => {
    if (activeId) queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }, [activeId, queryClient]);

  const headerThread = listed ?? fetchedHeader;
  const header: ConversationHeader | null = activeId
    ? headerThread
      ? {
          name: headerThread.counterpartName,
          avatarUrl: headerThread.counterpartAvatarUrl,
          personId: headerThread.studentId + headerThread.tenantId,
          kind: headerThread.counterpartKind ?? null,
          myLastReadAt: headerThread.myLastReadAt ?? null,
        }
      : null
    : drafting && resolved && !resolved.threadId
      ? {
          name: resolved.counterpartName,
          avatarUrl: resolved.counterpartAvatarUrl,
          personId: (draftStudent ?? '') + (draftTeacher ?? ''),
          kind: resolved.counterpartKind,
          myLastReadAt: null,
        }
      : null;
  const openError = activeId ? headerError : resolveError;

  const target: SendTarget | null = activeId
    ? { threadId: activeId }
    : draftStudent
      ? { studentId: draftStudent }
      : draftTeacher
        ? { tenantId: draftTeacher }
        : null;

  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['chat-threads'] }),
    [queryClient],
  );
  const back = useCallback(() => setParams({}), [setParams]);
  const onThreadCreated = useCallback(
    (threadId: string) => {
      // The first message just created the conversation: from here on the page
      // is that conversation, and back does not return to the draft.
      setParams({ t: threadId }, { replace: true });
      void refreshList();
    },
    [setParams, refreshList],
  );

  /** Take this conversation off my list. The other side keeps theirs. */
  const clear = useCallback(async () => {
    if (!activeId || !(await askConfirm(t('messages.clearConfirm')))) return;
    await api.delete(`/chat/threads/${activeId}`);
    setParams({});
    void refreshList();
  }, [activeId, setParams, refreshList, t]);

  // Phone: the conversation is a full-screen layer over the app shell.
  const fullScreen = showConversation && !desktop;
  const vv = useVisualViewport(fullScreen);
  useEffect(() => {
    if (!fullScreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [fullScreen]);

  const conversation = !showConversation ? (
    <div className="hidden h-full flex-col items-center justify-center gap-3 text-center lg:flex">
      <span className="grid h-20 w-20 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
        <span className="material-symbols-outlined text-4xl">chat</span>
      </span>
      <p className="font-heading text-lg font-bold text-on-surface">{t('messages.selectThread')}</p>
      <p className="max-w-xs text-sm text-on-surface-variant">{t('messages.selectThreadHint')}</p>
    </div>
  ) : openError ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="material-symbols-outlined text-4xl text-outline">lock</span>
      <p className="text-on-surface-variant">{errorMessage(openError)}</p>
      <button className="btn-secondary" onClick={back}>
        {t('messages.backToList')}
      </button>
    </div>
  ) : !header || !target ? (
    <div className="grid h-full place-items-center">
      <Spinner />
    </div>
  ) : (
    <Conversation
      threadId={activeId}
      target={target}
      header={header}
      onBack={back}
      onThreadCreated={onThreadCreated}
      onClear={activeId ? () => void clear() : null}
      onActivity={() => void refreshList()}
    />
  );

  const list = (
    <ConversationList
      threads={threads}
      activeId={activeId}
      loading={threadsQuery.isLoading}
      hasMore={!!threadsQuery.hasNextPage}
      loadingMore={threadsQuery.isFetchingNextPage}
      onLoadMore={() => void threadsQuery.fetchNextPage()}
      onOpen={(id) => setParams({ t: id })}
      lang={i18n.language}
      t={t}
    />
  );

  return (
    <div className="page">
      <PageHeader title={t('messages.title')} subtitle={t('messages.subtitle')} />
      <div className="card flex h-[calc(100dvh-15rem)] min-h-[28rem] overflow-hidden p-0 lg:h-[calc(100dvh-13rem)]">
        <aside
          className={`w-full shrink-0 border-e border-outline-variant/40 lg:w-[22rem] ${fullScreen ? 'hidden' : ''}`}
        >
          {list}
        </aside>
        {/* ONE element in one place for every layout — desktop pane or the
            phone's full-screen layer is only a change of classes. Rendering
            it in two different places remounted the conversation whenever the
            width crossed the breakpoint (a tablet rotating, a window resized),
            dropping the scroll position, the draft and the loaded history. */}
        <main
          className={
            fullScreen
              ? 'fixed inset-x-0 z-[45] bg-background'
              : desktop
                ? 'min-w-0 flex-1'
                : 'hidden'
          }
          style={fullScreen ? { top: vv?.top ?? 0, height: vv ? vv.height : '100dvh' } : undefined}
          role={fullScreen ? 'dialog' : undefined}
          aria-modal={fullScreen ? true : undefined}
          aria-label={fullScreen ? (header?.name ?? t('messages.title')) : undefined}
        >
          {conversation}
        </main>
      </div>
    </div>
  );
}

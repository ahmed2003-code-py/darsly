import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ChatMessageDto, ChatThreadDto, RealtimeEvents } from '@darsly/shared-types';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { EmptyState, PageHeader, Spinner } from '../components/ui';

export default function MessagesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('t');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number>();

  const { data: threads, isLoading } = useQuery<ChatThreadDto[]>({
    queryKey: ['chat-threads'],
    queryFn: async () => (await api.get('/chat/threads')).data,
    refetchInterval: 30_000,
  });
  const active = threads?.find((th) => th.id === activeId);

  // Load messages when a thread is opened.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api.get(`/chat/threads/${activeId}/messages`).then(({ data }) => {
      if (!cancelled) setMessages(data);
    });
    const socket = getSocket();
    socket?.emit(RealtimeEvents.JOIN_THREAD, activeId);
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    return () => {
      cancelled = true;
      socket?.emit(RealtimeEvents.LEAVE_THREAD, activeId);
    };
  }, [activeId, queryClient]);

  // Live incoming messages + typing echo.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onMessage = (m: ChatMessageDto) => {
      if (m.threadId === activeId) {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      }
      queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    };
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, peerTyping]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !activeId) return;
    setDraft('');
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit(RealtimeEvents.SEND_MESSAGE, { threadId: activeId, body });
    } else {
      // REST fallback: append the returned message directly.
      const { data } = await api.post('/chat/messages', { threadId: activeId, body });
      setMessages((prev) => [...prev, { ...data.message }]);
    }
  }

  function onType() {
    if (activeId) getSocket()?.emit(RealtimeEvents.TYPING, activeId);
  }

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('messages.title')} subtitle={t('messages.subtitle')} />

      <div className="card flex h-[70vh] overflow-hidden p-0">
        {/* Thread list */}
        <div className={`w-full border-e border-outline-variant/40 sm:w-80 ${activeId ? 'hidden sm:block' : ''}`}>
          {isLoading ? (
            <Spinner />
          ) : !threads?.length ? (
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
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                      {th.counterpartName?.trim()?.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-bold">{th.counterpartName}</span>
                        {th.unread > 0 && (
                          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-on-primary">
                            {th.unread}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-sm text-on-surface-variant">
                        {th.type === 'QA' && <span className="text-primary">❓ </span>}
                        {th.lastMessage ?? '—'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Conversation */}
        <div className={`flex flex-1 flex-col ${activeId ? '' : 'hidden sm:flex'}`}>
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-outline">
              <div className="text-center">
                <span className="material-symbols-outlined text-5xl text-outline-variant">chat</span>
                <p className="mt-2">{t('messages.selectThread')}</p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-outline-variant/40 px-5 py-3">
                <button className="sm:hidden" onClick={() => setParams({})}>
                  <span className="material-symbols-outlined rtl:rotate-180">arrow_back</span>
                </button>
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-fixed font-heading font-bold text-primary">
                  {active.counterpartName?.trim()?.charAt(0)}
                </span>
                <div>
                  <p className="font-bold">{active.counterpartName}</p>
                  {active.type === 'QA' && active.lessonTitle && (
                    <p className="text-xs text-primary">
                      {t('messages.qaBadge')} · {active.lessonTitle}
                    </p>
                  )}
                </div>
              </header>

              <div className="flex-1 space-y-2 overflow-y-auto bg-surface-container-low/40 p-5">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.mine ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                        m.mine
                          ? 'rounded-bs-sm bg-primary-container text-on-primary'
                          : 'rounded-be-sm bg-surface-container-lowest text-on-surface shadow-card'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={`mt-1 text-[10px] ${m.mine ? 'text-on-primary/70' : 'text-outline'}`} dir="ltr">
                        {new Date(m.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
                {peerTyping && (
                  <p className="text-xs text-outline">{t('messages.typing')}</p>
                )}
                <div ref={bottomRef} />
              </div>

              <form onSubmit={send} className="flex items-center gap-2 border-t border-outline-variant/40 p-3">
                <input
                  className="input py-2.5"
                  placeholder={t('messages.typePlaceholder')}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    onType();
                  }}
                />
                <button className="btn-primary px-5 py-2.5" disabled={!draft.trim()}>
                  <span className="material-symbols-outlined">send</span>
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

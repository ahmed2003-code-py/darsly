import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ChatMessageDto, ChatThreadDto, RealtimeEvents } from '@darsly/shared-types';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { EmptyState, PageHeader, Spinner } from '../components/ui';

/** Five minutes, matching the server. A voice note is a thought, not a lecture. */
const VOICE_MAX_SECONDS = 300;

export default function MessagesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('t');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [peerTyping, setPeerTyping] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessageDto | null>(null);
  const [notice, setNotice] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number>();

  const { data: threads, isLoading } = useQuery<ChatThreadDto[]>({
    queryKey: ['chat-threads'],
    queryFn: async () => (await api.get('/chat/threads')).data,
    // A conversation list that is a minute out of date reads as broken. Cheap
    // enough to ask often, and the socket usually gets there first anyway.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
  const active = threads?.find((th) => th.id === activeId);

  /**
   * The open conversation, polled as well as pushed.
   *
   * The socket is the fast path, but it is not a guarantee: a phone that slept,
   * a network that dropped the connection, a carrier that blocks the upgrade —
   * all of them end with a page that quietly stops receiving. Asking every few
   * seconds costs one small request and means a message always arrives.
   */
  const { data: fetched } = useQuery<ChatMessageDto[]>({
    queryKey: ['chat-messages', activeId],
    queryFn: async () => (await api.get(`/chat/threads/${activeId}/messages`)).data,
    enabled: !!activeId,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  // Merge what the poll brought with what the socket pushed, newest wins per id.
  useEffect(() => {
    if (!fetched) return;
    setMessages((prev) => {
      const byId = new Map(fetched.map((m) => [m.id, m]));
      for (const m of prev) if (!byId.has(m.id)) byId.set(m.id, m);
      return [...byId.values()].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    });
  }, [fetched]);

  useEffect(() => {
    setReplyTo(null);
    if (!activeId) {
      setMessages([]);
      return;
    }
    const socket = getSocket();
    socket?.emit(RealtimeEvents.JOIN_THREAD, activeId);
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    return () => {
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
    const replyToId = replyTo?.id;
    setReplyTo(null);
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit(RealtimeEvents.SEND_MESSAGE, { threadId: activeId, body, replyToId });
    } else {
      // REST fallback: append the returned message directly.
      const { data } = await api.post('/chat/messages', { threadId: activeId, body, replyToId });
      setMessages((prev) => [...prev, { ...data.message }]);
    }
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
        setMessages((prev) =>
          prev.some((x) => x.id === data.message.id) ? prev : [...prev, data.message],
        );
      } catch {
        setNotice(t('messages.voiceFailed'));
      }
    },
    [activeId, replyTo, t],
  );

  function onType() {
    if (activeId) getSocket()?.emit(RealtimeEvents.TYPING, activeId);
  }

  /** Take this conversation off my list. The other side keeps theirs. */
  async function clearThread(id: string) {
    if (!window.confirm(t('messages.clearConfirm'))) return;
    await api.delete(`/chat/threads/${id}`);
    if (id === activeId) setParams({});
    queryClient.invalidateQueries({ queryKey: ['chat-threads'] });
  }

  /** Group by day so a long conversation reads as days, not as one wall. */
  const grouped = useMemo(() => groupByDay(messages), [messages]);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('messages.title')} subtitle={t('messages.subtitle')} />

      {/* Sized against the viewport so the composer is always on screen and the
          message list scrolls rather than the page. The phone subtracts more
          because the bottom tab bar is sitting under it. */}
      <div className="card flex h-[calc(100dvh-17rem)] min-h-[26rem] overflow-hidden p-0 sm:h-[calc(100dvh-14rem)]">
        {/* Thread list */}
        <div
          className={`w-full border-e border-outline-variant/40 sm:w-80 sm:shrink-0 ${
            activeId ? 'hidden sm:block' : ''
          }`}
        >
          {isLoading ? (
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
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
            </ul>
          )}
        </div>

        {/* Conversation */}
        <div className={`flex min-w-0 flex-1 flex-col ${activeId ? '' : 'hidden sm:flex'}`}>
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-outline">
              <div className="text-center">
                <span className="material-symbols-outlined text-5xl text-outline-variant">chat</span>
                <p className="mt-2">{t('messages.selectThread')}</p>
              </div>
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
                <Avatar name={active.counterpartName} url={active.counterpartAvatarUrl} rem={2.5} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading font-bold">{active.counterpartName}</p>
                  <p className="truncate text-xs text-on-surface-variant">
                    {peerTyping ? t('messages.typing') : ''}
                  </p>
                </div>
                <button
                  onClick={() => void clearThread(active.id)}
                  title={t('messages.clear')}
                  aria-label={t('messages.clear')}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-outline transition hover:bg-error-container hover:text-on-error-container"
                >
                  <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
                </button>
              </header>

              <div className="flex-1 space-y-1 overflow-y-auto bg-surface-container-low/40 px-3 py-4 sm:px-5">
                {!messages.length && (
                  <p className="py-10 text-center text-sm text-on-surface-variant">
                    {t('messages.startHint')}
                  </p>
                )}
                {grouped.map(({ day, items }) => (
                  <div key={day} className="space-y-1">
                    <p className="sticky top-0 z-10 mx-auto my-3 w-fit rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-on-surface-variant">
                      {dayLabel(day, t, i18n.language)}
                    </p>
                    {items.map((m, i) => (
                      <Bubble
                        key={m.id}
                        m={m}
                        // Only the last of a run shows a tail and a timestamp,
                        // so three quick messages read as one turn, not three.
                        last={i === items.length - 1 || items[i + 1]?.mine !== m.mine}
                        onReply={() => {
                          setReplyTo(m);
                          inputRef.current?.focus();
                        }}
                        t={t}
                        lang={i18n.language}
                      />
                    ))}
                  </div>
                ))}
                <div ref={bottomRef} />
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
                onVoice={sendVoice}
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
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-primary"
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
  t,
  lang,
}: {
  m: ChatMessageDto;
  last: boolean;
  onReply: () => void;
  t: (k: string, o?: any) => string;
  lang: string;
}) {
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
              <span className="material-symbols-outlined text-[13px]">
                {m.readAt ? 'done_all' : 'done'}
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

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

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
      audio.onended = () => { setPlaying(false); setAt(0); };
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
          mine ? 'bg-black/15 text-on-primary' : 'bg-primary-fixed text-primary'
        }`}
      >
        <span className="material-symbols-outlined text-[20px]">
          {failed ? 'error' : playing ? 'pause' : 'play_arrow'}
        </span>
      </button>
      <span className="flex min-w-[7rem] flex-1 flex-col gap-1">
        <span className={`h-1.5 overflow-hidden rounded-full ${mine ? 'bg-black/20' : 'bg-surface-container-high'}`}>
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
  onVoice: (blob: Blob, seconds: number) => void;
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

  useEffect(() => () => {
    window.clearInterval(tickRef.current);
    stopTracks();
  }, []);

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
        if (!keepRef.current || seconds < 1) return;
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
          <span dir="ltr" className="tabular-nums text-on-surface-variant">{clock(elapsed)}</span>
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
    <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-outline-variant/40 p-3">
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
      {draft.trim() ? (
        <button className="btn-primary h-11 px-5" aria-label={t('messages.send')}>
          <span className="material-symbols-outlined rtl:-scale-x-100">send</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary-fixed text-primary transition hover:bg-primary hover:text-on-primary"
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

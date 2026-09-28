import { memo, useState } from 'react';
import type { ChatSenderKind } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import type { LocalMessage } from './messageList';
import { MessageAttachments } from './Attachments';
import {
  ActionSheet,
  HoverToolbar,
  MessageActionHandlers,
  useLongPress,
  useSwipeReply,
} from './MessageActions';
import RichText from './RichText';
import { filesOf, messagePreview, quoteLine, voiceOf } from './preview';
export { messagePreview } from './preview';
import VoiceNote from './VoiceNote';
import { clock, fullDateTime, RunPosition, timeLabel } from './format';

type T = (k: string, o?: any) => string;

export const roleKey = (kind?: ChatSenderKind | null) =>
  kind === 'OWNER' || kind === 'TEACHER'
    ? 'messages.roles.teacher'
    : kind === 'ASSISTANT'
      ? 'messages.roles.assistant'
      : kind === 'GUARDIAN'
        ? 'messages.roles.guardian'
        : kind === 'ADMIN'
          ? 'messages.roles.admin'
          : 'messages.roles.student';

/**
 * What stands beside a sender's name: an assistant's title, a guardian's
 * relationship to the child ("Father"), or their role.
 */
export function senderLabel(
  sender: { kind?: ChatSenderKind | null; title?: string | null },
  t: T,
): string {
  if (sender.kind === 'GUARDIAN') return t(`guardian.rel.${sender.title ?? 'GUARDIAN'}`);
  return sender.title || t(roleKey(sender.kind));
}

export interface BubbleProps {
  m: LocalMessage;
  run: RunPosition;
  /** Draw who sent it: incoming messages in a conversation, at the start of a turn. */
  showSender: boolean;
  highlighted: boolean;
  lang: string;
  t: T;
  onReply: (m: LocalMessage) => void;
  onReact: (id: string, emoji: string | null) => void;
  onDelete: (m: LocalMessage, scope: 'me' | 'everyone') => void;
  onJumpToQuote: (id: string) => void;
  onRetry: (clientMessageId: string) => void;
  onDiscard: (clientMessageId: string) => void;
  onCopied: () => void;
}

function MessageBubbleImpl({
  m,
  run,
  showSender,
  highlighted,
  lang,
  t,
  onReply,
  onReact,
  onDelete,
  onJumpToQuote,
  onRetry,
  onDiscard,
  onCopied,
}: BubbleProps) {
  const mine = !!m.mine;
  const deleted = !!m.deleted;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pending = m.status === 'sending' || m.status === 'failed';
  const myReaction = m.reactions?.find((r) => r.mine)?.emoji ?? null;
  const handlers: MessageActionHandlers = {
    onReply: deleted ? undefined : () => onReply(m),
    onReact: deleted ? undefined : (e) => onReact(m.id, e),
    onCopy:
      m.body && !deleted
        ? () => {
            void navigator.clipboard?.writeText(m.body).then(onCopied, () => undefined);
          }
        : undefined,
    onDeleteForMe: () => onDelete(m, 'me'),
    onDeleteForEveryone: mine && !deleted ? () => onDelete(m, 'everyone') : undefined,
    myReaction,
  };
  const swipe = useSwipeReply(!pending && !deleted ? () => onReply(m) : undefined);
  const longPress = useLongPress(() => !pending && !swipe.swiping() && setSheetOpen(true));
  const sender = m.sender;
  const voice = deleted ? null : voiceOf(m);
  const files = deleted ? [] : filesOf(m);
  const onlyImages =
    !deleted &&
    files.length > 0 &&
    !m.body &&
    !m.audio &&
    !voice &&
    !m.replyTo &&
    files.every((a) => a.kind === 'IMAGE');

  // One set of touch handlers: the swipe and the long press both listen.
  const touch = {
    onTouchStart: (e: React.TouchEvent) => {
      swipe.handlers.onTouchStart?.(e);
      longPress.onTouchStart(e);
    },
    onTouchMove: (e: React.TouchEvent) => {
      swipe.handlers.onTouchMove?.(e);
      longPress.onTouchMove(e);
    },
    onTouchEnd: () => {
      swipe.handlers.onTouchEnd?.();
      longPress.onTouchEnd();
    },
    onTouchCancel: () => {
      swipe.handlers.onTouchCancel?.();
      longPress.onTouchCancel();
    },
    onClickCapture: longPress.onClickCapture,
    onContextMenu: longPress.onContextMenu,
  };

  const quote = m.replyTo && !m.replyTo.unavailable ? quoteLine(m.replyTo, t) : null;

  return (
    <div
      id={`msg-${m.id}`}
      data-message-id={m.id}
      className={`group/msg flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${run.first ? 'mt-3' : 'mt-0.5'}`}
    >
      {/* Avatar column: only incoming messages, only at the start of a turn. */}
      {!mine && (
        <span className="w-8 shrink-0 self-start pt-5">
          {showSender && run.first && sender ? (
            <Avatar id={sender.id} name={sender.name} url={sender.avatarUrl} size={32} />
          ) : null}
        </span>
      )}

      {/* The column is capped, and so is every level inside it: a flex item in
          a column that is not stretched is sized from its content and may
          overflow the column unless told otherwise. That is what let a long
          file name push a whole bubble — and its text — off the screen. */}
      <div
        className={`flex min-w-0 max-w-[82%] flex-col sm:max-w-[min(68%,36rem)] ${mine ? 'items-end' : 'items-start'}`}
      >
        {showSender && run.first && sender && !mine && (
          <p className="mb-0.5 flex min-w-0 max-w-full items-baseline gap-1 px-1 text-xs">
            <bdi className="truncate font-bold text-on-surface">{sender.name}</bdi>
            <span className="shrink-0 text-on-surface-variant">· {senderLabel(sender, t)}</span>
          </p>
        )}

        <div
          className={`relative flex min-w-0 max-w-full items-center gap-1 ${mine ? 'flex-row-reverse' : ''}`}
          style={{ touchAction: 'pan-y' }}
          {...touch}
        >
          {/* Swipe to reply: the arrow waits behind the bubble's start edge. */}
          {swipe.progress > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute start-0 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full bg-surface-container-high text-on-surface-variant"
              style={{
                opacity: swipe.progress,
                transform: `translateY(-50%) scale(${0.6 + 0.4 * swipe.progress})`,
              }}
            >
              <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">reply</span>
            </span>
          )}
          <div
            tabIndex={pending ? -1 : 0}
            role="group"
            aria-label={t('messages.messageFrom', {
              name: mine ? t('messages.you') : (sender?.name ?? m.senderName),
              time: timeLabel(m.createdAt, lang),
            })}
            className={`relative min-w-0 max-w-full select-text rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              swipe.dx || swipe.settling ? '' : 'transition-shadow'
            } ${onlyImages ? 'p-1' : 'px-3 pb-1.5 pt-2'} ${
              m.status === 'failed'
                ? 'bg-error-container text-on-error-container'
                : deleted
                  ? 'bg-surface-container-high text-on-surface-variant'
                  : mine
                    ? 'bg-primary-container text-on-primary'
                    : 'bg-surface-container-lowest text-on-surface shadow-hairline'
            } ${run.last ? (mine ? 'rounded-ee-[4px]' : 'rounded-es-[4px]') : ''} ${
              highlighted ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
            } ${m.status === 'sending' ? 'opacity-80' : ''}`}
            style={{
              transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined,
              transition: swipe.settling ? 'transform 180ms ease-out' : undefined,
            }}
          >
            {m.replyTo && !deleted && (
              <button
                type="button"
                disabled={!!m.replyTo.unavailable}
                onClick={() => onJumpToQuote(m.replyTo!.id)}
                className={`mb-1.5 block w-full min-w-0 max-w-full rounded-[8px] border-s-[3px] px-2 py-1 text-start text-xs leading-snug transition ${
                  mine
                    ? 'border-on-primary/60 bg-black/10 text-on-primary/90 hover:bg-black/15'
                    : 'border-primary bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                } disabled:cursor-default`}
                aria-label={t('messages.goToQuoted')}
              >
                {m.replyTo.unavailable ? (
                  <span className="flex items-center gap-1 italic">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden>
                      block
                    </span>
                    {t('messages.unavailable')}
                  </span>
                ) : (
                  <>
                    <bdi className={`block truncate font-bold ${mine ? '' : 'text-primary-text'}`}>
                      {m.replyTo.senderName}
                    </bdi>
                    <span className="flex min-w-0 items-center gap-1">
                      {quote?.icon && (
                        <span
                          className="material-symbols-outlined shrink-0 text-[14px]"
                          aria-hidden
                        >
                          {quote.icon}
                        </span>
                      )}
                      <span dir="auto" className="min-w-0 truncate">
                        {quote?.text}
                      </span>
                    </span>
                  </>
                )}
              </button>
            )}

            {m.lesson && !deleted && (
              <p
                className={`mb-1 flex min-w-0 items-center gap-1 text-xs font-bold ${mine ? 'text-on-primary/85' : 'text-primary-text'}`}
              >
                <span className="material-symbols-outlined shrink-0 text-[15px]">play_lesson</span>
                <bdi className="truncate">{m.lesson.title}</bdi>
                {m.lesson.atSec != null && (
                  <span className="shrink-0" dir="ltr">
                    · {clock(m.lesson.atSec)}
                  </span>
                )}
              </p>
            )}

            {deleted ? (
              <p className="flex items-center gap-1.5 text-sm italic">
                <span className="material-symbols-outlined text-[17px]" aria-hidden>
                  block
                </span>
                {mine ? t('messages.youDeleted') : t('messages.messageDeleted')}
              </p>
            ) : (
              <>
                {m.body && <RichText text={m.body} onColor={mine && m.status !== 'failed'} />}
                {files.length > 0 && (
                  <div className={m.body ? 'mt-1.5' : ''}>
                    <MessageAttachments items={files} mine={mine} lang={lang} t={t} />
                  </div>
                )}
                {(voice || m.audio) && (
                  <div className={m.body || files.length ? 'mt-1.5' : ''}>
                    {voice ? (
                      <VoiceNote
                        src={voice.url}
                        seconds={voice.durationSec ?? 0}
                        mine={mine}
                        t={t}
                      />
                    ) : (
                      <VoiceNote
                        messageId={m.id}
                        seconds={m.audio!.durationSec}
                        mine={mine}
                        t={t}
                      />
                    )}
                  </div>
                )}
                {!m.body && !files.length && !voice && !m.audio && (
                  <p className="text-sm italic opacity-70">{t('messages.unsupported')}</p>
                )}
              </>
            )}

            {(run.last || pending || deleted) && (
              <p
                className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none ${
                  onlyImages
                    ? 'absolute bottom-2 end-2 rounded-full bg-black/45 px-1.5 py-1 text-white'
                    : ''
                } ${!onlyImages ? (mine && !deleted ? 'text-on-primary/70' : 'text-on-surface-variant') : ''}`}
                dir="ltr"
                title={fullDateTime(m.createdAt, lang)}
              >
                {timeLabel(m.createdAt, lang)}
                {mine && !deleted && (
                  <span
                    className="material-symbols-outlined text-[14px]"
                    aria-label={
                      m.status === 'sending'
                        ? t('messages.sending')
                        : m.status === 'failed'
                          ? t('messages.sendFailed')
                          : m.readAt || m.seenCount
                            ? t('messages.seen')
                            : t('messages.sent')
                    }
                  >
                    {m.status === 'sending'
                      ? 'schedule'
                      : m.status === 'failed'
                        ? 'error'
                        : m.readAt || m.seenCount
                          ? 'done_all'
                          : 'done'}
                  </span>
                )}
                {/* A group: how many have read it — a number, never a row of faces. */}
                {mine && !deleted && !!m.seenCount && (
                  <span aria-label={t('messages.seenByCount', { count: m.seenCount })}>
                    {m.seenCount}
                  </span>
                )}
              </p>
            )}
          </div>

          {!pending && (
            <HoverToolbar
              handlers={handlers}
              mine={mine}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              t={t}
            />
          )}
        </div>

        {!!m.reactions?.length && !deleted && (
          <div
            className={`relative z-[1] -mt-1.5 flex max-w-full flex-wrap gap-1 px-2 ${mine ? 'justify-end' : ''}`}
          >
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReact(m.id, r.mine ? null : r.emoji)}
                title={r.names.join('، ')}
                aria-pressed={r.mine}
                aria-label={t('messages.reactionCount', { emoji: r.emoji, count: r.count })}
                className={`flex h-6 items-center gap-1 rounded-full px-1.5 text-[13px] shadow-hairline ring-2 ring-background transition ${
                  r.mine
                    ? 'bg-primary-fixed text-on-primary-fixed'
                    : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container-high'
                }`}
              >
                <span>{r.emoji}</span>
                {r.count > 1 && (
                  <span className="text-[11px] font-bold" dir="ltr">
                    {r.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {m.status === 'failed' && m.clientMessageId && (
          <p className="mt-1 flex items-center gap-3 px-1 text-xs">
            <span className="text-error">{t('messages.sendFailed')}</span>
            <button
              type="button"
              onClick={() => onRetry(m.clientMessageId!)}
              className="font-bold text-primary-text"
            >
              {t('messages.retry')}
            </button>
            <button
              type="button"
              onClick={() => onDiscard(m.clientMessageId!)}
              className="text-on-surface-variant"
            >
              {t('messages.discard')}
            </button>
          </p>
        )}
      </div>

      {sheetOpen && (
        <ActionSheet
          handlers={handlers}
          preview={messagePreview(m, t)}
          onClose={() => setSheetOpen(false)}
          t={t}
        />
      )}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);

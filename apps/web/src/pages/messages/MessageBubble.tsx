import { memo, useState } from 'react';
import type { ChatSenderKind } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import type { LocalMessage } from './messageList';
import { MessageAttachments } from './Attachments';
import { ActionSheet, HoverToolbar, MessageActionHandlers, useLongPress } from './MessageActions';
import RichText from './RichText';
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

/** What a quote or a sheet shows for a message that may have no text. */
export function messagePreview(m: LocalMessage, t: T): string {
  if (m.body) return m.body;
  if (m.audio) return `🎤 ${t('messages.voiceNote')}`;
  const a = m.attachments?.[0];
  if (a) return a.kind === 'IMAGE' ? `📷 ${t('messages.photo')}` : `📎 ${a.name}`;
  return '';
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
  onJumpToQuote,
  onRetry,
  onDiscard,
  onCopied,
}: BubbleProps) {
  const mine = !!m.mine;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pending = m.status === 'sending' || m.status === 'failed';
  const myReaction = m.reactions?.find((r) => r.mine)?.emoji ?? null;
  const handlers: MessageActionHandlers = {
    onReply: () => onReply(m),
    onReact: (e) => onReact(m.id, e),
    onCopy: m.body
      ? () => {
          void navigator.clipboard?.writeText(m.body).then(onCopied, () => undefined);
        }
      : undefined,
    myReaction,
  };
  const longPress = useLongPress(() => !pending && setSheetOpen(true));
  const sender = m.sender;
  const hasMedia = !!m.attachments?.length;
  const onlyImages =
    hasMedia && !m.body && !m.audio && m.attachments!.every((a) => a.kind === 'IMAGE');

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

      <div
        className={`flex min-w-0 max-w-[82%] flex-col sm:max-w-[68%] ${mine ? 'items-end' : 'items-start'}`}
      >
        {showSender && run.first && sender && !mine && (
          <p className="mb-1 flex min-w-0 items-baseline gap-1.5 px-1 text-xs">
            <bdi className="truncate font-bold text-on-surface">{sender.name}</bdi>
            <span className="shrink-0 text-on-surface-variant">
              · {sender.title || t(roleKey(sender.kind))}
            </span>
          </p>
        )}

        <div className={`flex items-center gap-1 ${mine ? 'flex-row-reverse' : ''}`}>
          <div
            tabIndex={pending ? -1 : 0}
            role="group"
            aria-label={t('messages.messageFrom', {
              name: mine ? t('messages.you') : (sender?.name ?? m.senderName),
              time: timeLabel(m.createdAt, lang),
            })}
            {...longPress}
            className={`relative min-w-0 select-text rounded-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-primary ${
              onlyImages ? 'p-1' : 'px-3 py-2'
            } ${
              m.status === 'failed'
                ? 'bg-error-container text-on-error-container'
                : mine
                  ? 'bg-primary-container text-on-primary'
                  : 'bg-surface-container-lowest text-on-surface shadow-hairline'
            } ${run.last ? (mine ? 'rounded-ee-[4px]' : 'rounded-es-[4px]') : ''} ${
              highlighted ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
            } ${m.status === 'sending' ? 'opacity-80' : ''}`}
          >
            {m.replyTo && (
              <button
                type="button"
                disabled={!!m.replyTo.unavailable}
                onClick={() => onJumpToQuote(m.replyTo!.id)}
                className={`mb-1.5 block w-full max-w-full rounded-[8px] border-s-[3px] px-2.5 py-1.5 text-start text-xs transition ${
                  mine
                    ? 'border-on-primary/60 bg-black/10 text-on-primary/90 hover:bg-black/15'
                    : 'border-primary bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                } disabled:cursor-default`}
                aria-label={t('messages.goToQuoted')}
              >
                {m.replyTo.unavailable ? (
                  <span className="italic">{t('messages.unavailable')}</span>
                ) : (
                  <>
                    <bdi className={`block font-bold ${mine ? '' : 'text-primary-text'}`}>
                      {m.replyTo.senderName}
                    </bdi>
                    <span dir="auto" className="line-clamp-2 [overflow-wrap:anywhere]">
                      {m.replyTo.body ||
                        (m.replyTo.isVoice
                          ? `🎤 ${t('messages.voiceNote')}`
                          : m.replyTo.attachmentKind === 'IMAGE'
                            ? `📷 ${t('messages.photo')}`
                            : m.replyTo.attachmentKind
                              ? `📎 ${t('messages.file')}`
                              : '')}
                    </span>
                  </>
                )}
              </button>
            )}

            {m.lesson && (
              <p
                className={`mb-1.5 flex items-center gap-1 text-xs font-bold ${mine ? 'text-on-primary/85' : 'text-primary-text'}`}
              >
                <span className="material-symbols-outlined text-[15px]">play_lesson</span>
                <bdi className="truncate">{m.lesson.title}</bdi>
                {m.lesson.atSec != null && <span dir="ltr">· {clock(m.lesson.atSec)}</span>}
              </p>
            )}

            {hasMedia && (
              <div className={m.body ? 'mb-1.5' : ''}>
                <MessageAttachments items={m.attachments!} mine={mine} lang={lang} t={t} />
              </div>
            )}

            {m.audio ? (
              <VoiceNote id={m.id} seconds={m.audio.durationSec} mine={mine} t={t} />
            ) : m.body ? (
              <RichText text={m.body} onColor={mine && m.status !== 'failed'} />
            ) : !hasMedia ? (
              <p className="text-sm italic opacity-70">{t('messages.unsupported')}</p>
            ) : null}

            {(run.last || pending) && (
              <p
                className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none ${
                  onlyImages
                    ? 'absolute bottom-2 end-2 rounded-full bg-black/45 px-1.5 py-1 text-white'
                    : ''
                } ${!onlyImages ? (mine ? 'text-on-primary/70' : 'text-on-surface-variant') : ''}`}
                dir="ltr"
                title={fullDateTime(m.createdAt, lang)}
              >
                {timeLabel(m.createdAt, lang)}
                {mine && (
                  <span
                    className="material-symbols-outlined text-[14px]"
                    aria-label={
                      m.status === 'sending'
                        ? t('messages.sending')
                        : m.status === 'failed'
                          ? t('messages.sendFailed')
                          : m.readAt
                            ? t('messages.seen')
                            : t('messages.sent')
                    }
                  >
                    {m.status === 'sending'
                      ? 'schedule'
                      : m.status === 'failed'
                        ? 'error'
                        : m.readAt
                          ? 'done_all'
                          : 'done'}
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

        {!!m.reactions?.length && (
          <div className={`-mt-1 flex flex-wrap gap-1 px-1 ${mine ? 'justify-end' : ''}`}>
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onReact(m.id, r.mine ? null : r.emoji)}
                title={r.names.join('، ')}
                aria-pressed={r.mine}
                aria-label={t('messages.reactionCount', { emoji: r.emoji, count: r.count })}
                className={`flex h-7 items-center gap-1 rounded-full px-2 text-sm shadow-hairline transition ${
                  r.mine
                    ? 'bg-primary-fixed text-on-primary-fixed'
                    : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container-high'
                }`}
              >
                <span>{r.emoji}</span>
                {r.count > 1 && (
                  <span className="text-xs font-bold" dir="ltr">
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

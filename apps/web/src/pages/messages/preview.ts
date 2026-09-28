import type { ChatMessageDto } from '@darsly/shared-types';
import type { LocalMessage } from './messageList';

/**
 * One-line summaries of a message — for quotes, the reply strip and the
 * action sheet. Pure functions, no network, so they are shared and tested.
 */

type T = (k: string, o?: any) => string;

export const voiceOf = (m: Pick<ChatMessageDto, 'attachments'>) =>
  m.attachments?.find((a) => a.kind === 'VOICE') ?? null;
export const filesOf = (m: Pick<ChatMessageDto, 'attachments'>) =>
  (m.attachments ?? []).filter((a) => a.kind !== 'VOICE');

/**
 * One line for a message that may have no text: what a quote, the reply
 * strip and the action sheet show. Text wins; then voice; then files.
 */
export function messagePreview(m: LocalMessage, t: T): string {
  if (m.deleted) return t('messages.messageDeleted');
  if (m.body) return m.body;
  const files = filesOf(m);
  if (m.audio || voiceOf(m)) {
    return files.length
      ? `🎤 ${t('messages.voiceNote')} · 📎 ${files.length}`
      : `🎤 ${t('messages.voiceNote')}`;
  }
  const a = files[0];
  if (a) {
    const more = files.length > 1 ? ` +${files.length - 1}` : '';
    return a.kind === 'IMAGE' ? `📷 ${t('messages.photo')}${more}` : `📎 ${a.name}${more}`;
  }
  return '';
}

/** What a quote of this message says, as an icon and one line. */
export function quoteLine(
  r: NonNullable<ChatMessageDto['replyTo']>,
  t: T,
): { icon?: string; text: string } {
  if (r.body) return { text: r.body };
  if (r.isVoice) {
    return {
      icon: 'mic',
      text: r.attachmentCount
        ? `${t('messages.voiceNote')} · ${t('messages.filesCount', { count: r.attachmentCount })}`
        : t('messages.voiceNote'),
    };
  }
  if (r.attachmentKind === 'IMAGE') {
    const n = r.attachmentCount ?? 1;
    return {
      icon: 'image',
      text: n > 1 ? `${t('messages.photo')} +${n - 1}` : t('messages.photo'),
    };
  }
  if (r.attachmentKind) {
    const n = r.attachmentCount ?? 1;
    const name = r.attachmentName || t('messages.file');
    return { icon: 'description', text: n > 1 ? `${name} +${n - 1}` : name };
  }
  return { text: '' };
}

/** The quote a reply carries, built locally for the bubble shown while sending. */
export function replyOf(m: ChatMessageDto): NonNullable<ChatMessageDto['replyTo']> {
  if (m.deleted) return { id: m.id, senderName: '', body: '', isVoice: false, unavailable: true };
  const files = (m.attachments ?? []).filter((a) => a.kind !== 'VOICE');
  return {
    id: m.id,
    senderName: m.senderName,
    body: m.body.length > 160 ? m.body.slice(0, 160) + '…' : m.body,
    isVoice: !!m.audio || (m.attachments ?? []).some((a) => a.kind === 'VOICE'),
    attachmentKind: files[0]?.kind ?? null,
    attachmentName: files[0]?.name ?? null,
    attachmentCount: files.length,
  };
}

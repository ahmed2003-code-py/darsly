import type { ChatAttachmentDto, ChatMessageDto } from '@darsly/shared-types';
import { applyDeleted, LocalMessage } from './messageList';
import { replyOf } from './preview';
import { messagePreview } from './preview';

const t = (k: string, o?: any) => (o?.count != null ? `${k}:${o.count}` : k);
const att = (kind: ChatAttachmentDto['kind'], name = 'x'): ChatAttachmentDto => ({
  id: `a-${kind}-${name}`,
  kind,
  name,
  mimeType: kind === 'VOICE' ? 'audio/webm' : kind === 'IMAGE' ? 'image/webp' : 'application/pdf',
  size: 10,
  width: null,
  height: null,
  url: '/u',
  previewUrl: null,
  downloadUrl: '/d',
  durationSec: kind === 'VOICE' ? 7 : null,
});
const msg = (id: string, extra: Partial<ChatMessageDto> = {}): LocalMessage =>
  ({
    id,
    threadId: 't',
    senderId: 'u1',
    senderName: 'Mona',
    senderRole: 'TEACHER',
    body: 'hello',
    readAt: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    reactions: [{ emoji: '👍', count: 1, mine: false, names: ['x'] }],
    ...extra,
  }) as LocalMessage;

describe('applyDeleted', () => {
  it('for me: the message leaves only this list', () => {
    const list = [msg('a'), msg('b')];
    expect(applyDeleted(list, 'a', 'me').map((m) => m.id)).toEqual(['b']);
    expect(applyDeleted(list, 'zzz', 'me')).toBe(list);
  });

  it('for everyone: a tombstone with nothing left, and quotes of it become unavailable', () => {
    const list = [
      msg('a', { body: 'secret', attachments: [att('VOICE'), att('FILE')] }),
      msg('b', { replyTo: { id: 'a', senderName: 'Mona', body: 'secret', isVoice: true } }),
    ];
    const next = applyDeleted(list, 'a', 'everyone');
    expect(next[0]).toMatchObject({
      deleted: true,
      body: '',
      attachments: [],
      reactions: [],
      audio: null,
    });
    expect(next[1].replyTo).toMatchObject({ id: 'a', unavailable: true, body: '' });
    expect(JSON.stringify(next)).not.toContain('secret');
  });
});

describe('compact previews of combined messages', () => {
  it('a reply to voice + file reads as voice, with the file named', () => {
    const r = replyOf(
      msg('a', { body: '', attachments: [att('VOICE'), att('FILE', 'الواجب.pdf')] }),
    );
    expect(r).toMatchObject({
      isVoice: true,
      attachmentKind: 'FILE',
      attachmentName: 'الواجب.pdf',
      attachmentCount: 1,
    });
  });

  it('a long text is cut for the quote, never sent whole', () => {
    const r = replyOf(msg('a', { body: 'ا'.repeat(500) }));
    expect(r.body.length).toBeLessThanOrEqual(161);
  });

  it('the one-line preview covers text, voice, voice + files, photos, files and deleted', () => {
    expect(messagePreview(msg('a'), t)).toBe('hello');
    expect(messagePreview(msg('a', { body: '', attachments: [att('VOICE')] }), t)).toBe(
      '🎤 messages.voiceNote',
    );
    expect(
      messagePreview(msg('a', { body: '', attachments: [att('VOICE'), att('FILE')] }), t),
    ).toBe('🎤 messages.voiceNote · 📎 1');
    expect(
      messagePreview(msg('a', { body: '', attachments: [att('IMAGE'), att('IMAGE', 'y')] }), t),
    ).toBe('📷 messages.photo +1');
    expect(messagePreview(msg('a', { body: '', attachments: [att('FILE', 'cv.pdf')] }), t)).toBe(
      '📎 cv.pdf',
    );
    expect(messagePreview(msg('a', { deleted: true }), t)).toBe('messages.messageDeleted');
  });
});

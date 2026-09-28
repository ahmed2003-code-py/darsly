import {
  ChatAttachmentDto,
  ChatAttachmentKind,
  ChatMessageDto,
  ChatReactionDto,
  ChatSenderKind,
  Role,
} from '@darsly/shared-types';
import { avatarUrl, chatFileUrl } from '../common/signed-link';

/**
 * What every read of a message loads, in one Prisma include (batched per page,
 * never per message): the sender as a participant, the attachments, and one
 * level of the message it answers — a quote of a quote is noise, and following
 * the chain would be an unbounded join.
 *
 * Nested includes are NOT filtered by the soft-delete middleware, which is why
 * `replyTo.deletedAt` is selected: a removed original is shown as
 * "unavailable" rather than quoted.
 */
export const MESSAGE_INCLUDE = {
  sender: {
    select: { id: true, fullName: true, role: true, avatarUrl: true, updatedAt: true },
  },
  replyTo: {
    select: {
      id: true,
      body: true,
      audioKey: true,
      deletedAt: true,
      revokedAt: true,
      sender: { select: { fullName: true } },
      attachments: {
        select: { kind: true, fileName: true },
        take: 6,
        orderBy: { createdAt: 'asc' as const },
      },
    },
  },
  lesson: { select: { id: true, title: true } },
  attachments: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      width: true,
      height: true,
      previewKey: true,
      durationSec: true,
    },
  },
} as const;

/** The reactions of a page of messages, keyed by message, as the viewer sees them. */
export type ReactionRow = { messageId: string; emoji: string; userId: string; name: string };

const NAMES_CAP = 10;

/** Group raw reaction rows into per-message, per-emoji chips, in a stable order. */
export function aggregateReactions(
  rows: ReactionRow[],
  viewerUserId: string,
): Map<string, ChatReactionDto[]> {
  const byMessage = new Map<string, Map<string, ChatReactionDto>>();
  for (const r of rows) {
    let chips = byMessage.get(r.messageId);
    if (!chips) byMessage.set(r.messageId, (chips = new Map()));
    let chip = chips.get(r.emoji);
    if (!chip) chips.set(r.emoji, (chip = { emoji: r.emoji, count: 0, mine: false, names: [] }));
    chip.count += 1;
    if (r.userId === viewerUserId) chip.mine = true;
    if (chip.names.length < NAMES_CAP) chip.names.push(r.name);
  }
  const out = new Map<string, ChatReactionDto[]>();
  for (const [id, chips] of byMessage) {
    // Most-used first; ties keep the order the emoji were first used in.
    out.set(
      id,
      [...chips.values()].sort((a, b) => b.count - a.count),
    );
  }
  return out;
}

/**
 * The sender's role in the conversation. Frozen on the message when it was
 * sent; for the rare row the backfill could not place, fall back to the
 * account role — never to anything that could promote someone.
 */
export function senderKindOf(m: {
  senderKind: string | null;
  sender: { role: string };
}): ChatSenderKind {
  const k = m.senderKind as ChatSenderKind | null;
  if (k) return k;
  if (m.sender.role === Role.SUPER_ADMIN) return 'ADMIN';
  if (m.sender.role === Role.TEACHER) return 'TEACHER';
  return 'STUDENT';
}

/** What a one-line list preview (and a notification) says for a message. */
export function previewOf(m: {
  body: string;
  audioKey?: string | null;
  revokedAt?: Date | string | null;
  attachments?: { kind: string; fileName?: string }[];
}): string {
  if (m.revokedAt) return '🚫 تم حذف الرسالة';
  if (m.body) return m.body.length > 80 ? m.body.slice(0, 80) + '…' : m.body;
  const files = (m.attachments ?? []).filter((a) => a.kind !== 'VOICE');
  if (m.audioKey || (m.attachments ?? []).some((a) => a.kind === 'VOICE')) {
    return files.length ? `🎤 رسالة صوتية + ${files.length} 📎` : '🎤 رسالة صوتية';
  }
  const a = files[0];
  if (a) {
    const more = files.length > 1 ? ` +${files.length - 1}` : '';
    return a.kind === 'IMAGE' ? `📷 صورة${more}` : `📎 ${a.fileName ?? 'ملف'}${more}`;
  }
  return '';
}

export function attachmentDto(a: {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  previewKey: string | null;
  durationSec?: number | null;
}): ChatAttachmentDto {
  return {
    id: a.id,
    kind: a.kind as ChatAttachmentDto['kind'],
    name: a.fileName,
    mimeType: a.mimeType,
    size: a.sizeBytes,
    width: a.width,
    height: a.height,
    url: chatFileUrl(a.id, 'full'),
    previewUrl: a.kind === 'IMAGE' && a.previewKey ? chatFileUrl(a.id, 'preview') : null,
    downloadUrl: chatFileUrl(a.id, 'download'),
    durationSec: a.kind === 'VOICE' ? (a.durationSec ?? null) : null,
  };
}

/** A quoted message, reduced to what one compact line needs. */
function replySummary(r: any): ChatMessageDto['replyTo'] {
  if (r.deletedAt || r.revokedAt) {
    return { id: r.id, senderName: '', body: '', isVoice: false, unavailable: true };
  }
  const attachments: { kind: string; fileName: string }[] = r.attachments ?? [];
  const files = attachments.filter((a) => a.kind !== 'VOICE');
  return {
    id: r.id,
    senderName: r.sender?.fullName ?? '',
    // Enough for two lines of a quote; never the whole of a long message.
    body: r.body.length > 160 ? r.body.slice(0, 160) + '…' : r.body,
    isVoice: !!r.audioKey || attachments.some((a) => a.kind === 'VOICE'),
    attachmentKind: (files[0]?.kind as ChatAttachmentKind | undefined) ?? null,
    attachmentName: files[0]?.fileName ?? null,
    attachmentCount: files.length,
  };
}

/**
 * One message as one viewer sees it.
 *
 * `seenBy` is how far the OTHER participants have read (the newest of their
 * cursors): the viewer's own message shows ✓✓ once someone on the other side
 * has read past it. It is a cursor, not a per-message flag, so it keeps
 * meaning the same thing when a side has several people on it.
 */
export function toMessageDto(
  m: any,
  viewerUserId: string,
  ctx: { reactions?: Map<string, ChatReactionDto[]>; seenBy?: Date | null } = {},
): ChatMessageDto {
  const mine = m.senderId === viewerUserId;
  const seen = mine && ctx.seenBy && ctx.seenBy.getTime() >= new Date(m.createdAt).getTime();
  const kind = senderKindOf(m);
  // Deleted for everyone: who and when stay (the conversation keeps its
  // shape); nothing that was said, attached or recorded is sent again.
  const revoked = !!m.revokedAt;
  return {
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderId,
    senderName: m.sender.fullName,
    senderRole: m.sender.role,
    body: revoked ? '' : m.body,
    readAt: seen ? ctx.seenBy!.toISOString() : null,
    createdAt: new Date(m.createdAt).toISOString(),
    mine,
    // Only the sender's own copy carries it: it is how their open tab matches
    // the stored message to the bubble it drew while the send was in flight.
    clientMessageId: mine ? (m.clientMessageId ?? null) : null,
    sender: {
      id: m.sender.id,
      name: m.sender.fullName,
      avatarUrl: avatarUrl(m.sender),
      kind,
      title: m.senderTitle ?? null,
    },
    replyTo: m.replyTo && !revoked ? replySummary(m.replyTo) : null,
    audio:
      m.audioKey && !revoked
        ? { durationSec: m.audioDurationSec ?? 0, bytes: m.audioBytes ?? 0 }
        : null,
    lesson:
      m.lesson && !revoked
        ? { id: m.lesson.id, title: m.lesson.title, atSec: m.videoTimestampSec ?? null }
        : null,
    attachments: revoked ? [] : (m.attachments ?? []).map(attachmentDto),
    reactions: revoked ? [] : (ctx.reactions?.get(m.id) ?? []),
    ...(revoked ? { deleted: true } : {}),
  };
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fsp, createReadStream } from 'fs';
import { ChatAttachmentDto, JwtPayload } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProvider } from '../storage/storage.provider';
import { ChatFileVariant, verifyLink } from '../common/signed-link';
import { attachmentDto } from './chat-presenter';
import { newThreadId, threadKey } from './chat-thread.identity';
import { ChatTarget, ChatService } from './chat.service';

// sharp is a native dep, loaded the way the rest of the API loads it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');

export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** What one person may upload in 24 hours, sent or not. */
export const CHAT_DAILY_UPLOAD_BYTES = 200 * 1024 * 1024;
/** An upload never sent is removed after this long. */
const PENDING_TTL_MS = 24 * 3600 * 1000;
/** Pixels sharp will agree to decode — a decompression bomb stops here. */
const MAX_INPUT_PIXELS = 50_000_000;

type Detected = { kind: 'IMAGE' | 'FILE'; mime: string; ext: string };

const startsWith = (b: Buffer, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);
const isZip = (b: Buffer) =>
  startsWith(b, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0x50, 0x4b, 0x05, 0x06);
const isOle2 = (b: Buffer) => startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const isHeif = (b: Buffer) =>
  b.length > 11 &&
  b.toString('latin1', 4, 8) === 'ftyp' &&
  /^(heic|heix|hevc|hevx|mif1|msf1|avif)$/.test(b.toString('latin1', 8, 12));

const OFFICE_ZIP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OFFICE_OLE: Record<string, string> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

/**
 * What a file IS, from its bytes — the declared type and the name are never
 * trusted for this. The name's extension is only used to tell apart formats
 * that share a container (a .docx and a .xlsx are both zips), and only among
 * the formats allowed; a plain .zip, or a zip named anything else, is refused.
 */
export function detectChatFile(head: Buffer, fileName: string): Detected | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47))
    return { kind: 'IMAGE', mime: 'image/png', ext: 'png' };
  if (startsWith(head, 0xff, 0xd8, 0xff)) return { kind: 'IMAGE', mime: 'image/jpeg', ext: 'jpg' };
  if (
    head.length > 11 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP'
  )
    return { kind: 'IMAGE', mime: 'image/webp', ext: 'webp' };
  if (startsWith(head, 0x25, 0x50, 0x44, 0x46))
    return { kind: 'FILE', mime: 'application/pdf', ext: 'pdf' };
  if (isZip(head) && OFFICE_ZIP[ext]) return { kind: 'FILE', mime: OFFICE_ZIP[ext], ext };
  if (isOle2(head) && OFFICE_OLE[ext]) return { kind: 'FILE', mime: OFFICE_OLE[ext], ext };
  if (ext === 'txt' && head.length && !head.includes(0x00) && !isZip(head))
    return { kind: 'FILE', mime: 'text/plain', ext: 'txt' };
  return null;
}

/**
 * The name to SHOW for a file. Never used to build a path: storage keys are
 * generated. Strips directories, control characters and bidi overrides (a
 * name like "fdp.exe" written right-to-left can pose as "exe.pdf"), and caps
 * the length while keeping the real extension.
 */
export function cleanFileName(raw: string, ext: string): string {
  // Multer decodes the multipart filename as latin1; recover UTF-8 (Arabic
  // names). Only when it really is latin1-decoded bytes — a string that
  // already holds characters above U+00FF is proper text and is kept as is.
  let name = raw ?? '';
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-ÿ]*$/.test(name)) {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    if (!utf8.includes('�')) name = utf8;
  }
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '');
  name = name.replace(/\s+/g, ' ').trim();
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  stem = stem.slice(0, 100).trim() || 'file';
  return `${stem}.${ext}`;
}

/** Where the file will be sent — the same target a message names (see ChatTarget). */
export type UploadTarget = ChatTarget;

@Injectable()
export class ChatAttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAttachmentsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly chat: ChatService,
  ) {}

  onModuleInit(): void {
    if ((process.env.CHAT_ATTACHMENT_SWEEP_ENABLED ?? 'true') !== 'true') return;
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), 60 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Take a file from the composer. Creates NO conversation.
   *
   * The upload is authorized exactly like a send to the same target, then tied
   * to the uploader and to that conversation: its thread when one exists, or
   * the identity key the conversation WILL have (the same value the first send
   * computes). Only a send by the same person to that conversation can bind it.
   */
  async upload(
    user: JwtPayload,
    file: { path: string; originalname: string; size: number },
    target: UploadTarget,
  ): Promise<ChatAttachmentDto> {
    try {
      const auth = await this.chat.authorizeTarget(user, target);
      let threadId: string | null = null;
      let targetKey: string | null = null;
      if ('threadId' in auth) {
        threadId = auth.threadId;
      } else {
        targetKey = threadKey(auth.identity);
        const existing = await this.prisma.chatThread.findUnique({
          where: { dedupeKey: targetKey },
          select: { id: true, deletedAt: true },
        });
        if (existing && !existing.deletedAt) threadId = existing.id;
      }

      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const used = await this.prisma.chatAttachment.aggregate({
        where: { uploaderId: user.sub, createdAt: { gt: since } },
        _sum: { sizeBytes: true },
      });
      if ((used._sum.sizeBytes ?? 0) + file.size > CHAT_DAILY_UPLOAD_BYTES) {
        throw new BadRequestException({
          message: 'You have reached today’s upload limit',
          code: 'UPLOAD_QUOTA',
        });
      }

      const head = await this.readHead(file.path);
      if (isHeif(head)) {
        throw new BadRequestException({
          message: 'HEIC photos are not supported — send it as JPG',
          code: 'IMAGE_HEIC',
        });
      }
      const detected = detectChatFile(head, file.originalname ?? '');
      if (!detected) {
        throw new BadRequestException({
          message: 'This kind of file cannot be sent',
          code: 'ATTACHMENT_TYPE',
        });
      }
      const max = detected.kind === 'IMAGE' ? CHAT_IMAGE_MAX_BYTES : CHAT_FILE_MAX_BYTES;
      if (file.size > max) {
        throw new BadRequestException({
          message: `The file is larger than ${Math.round(max / 1024 / 1024)} MB`,
          code: 'ATTACHMENT_TOO_LARGE',
        });
      }

      const id = newThreadId();
      const base = { id, uploaderId: user.sub, threadId, targetKey };
      let saved;
      if (detected.kind === 'IMAGE') {
        // Re-encoded, not stored as sent: this drops EXIF (including where a
        // phone photo was taken), normalises orientation, and turns whatever
        // was in the file into a plain image — a polyglot cannot survive it.
        let full: { data: Buffer; info: { width: number; height: number } };
        let preview: Buffer;
        try {
          full = await sharp(file.path, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer({ resolveWithObject: true });
          preview = await sharp(full.data)
            .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 72 })
            .toBuffer();
        } catch {
          throw new BadRequestException({
            message: 'This image could not be read',
            code: 'IMAGE_UNREADABLE',
          });
        }
        const storageKey = `chat-files/${id}.webp`;
        const previewKey = `chat-files/${id}-preview.webp`;
        const opts = { contentType: 'image/webp', cacheControl: 'private, max-age=86400' };
        await this.storage.put(storageKey, full.data, opts);
        await this.storage.put(previewKey, preview, opts);
        saved = await this.prisma.chatAttachment.create({
          data: {
            ...base,
            kind: 'IMAGE',
            storageKey,
            previewKey,
            fileName: cleanFileName(file.originalname, 'webp'),
            mimeType: 'image/webp',
            sizeBytes: full.data.length,
            width: full.info.width,
            height: full.info.height,
            sha256: createHash('sha256').update(full.data).digest('hex'),
          },
        });
      } else {
        const storageKey = `chat-files/${id}.${detected.ext}`;
        const sha256 = await this.hashFile(file.path);
        await this.storage.put(storageKey, createReadStream(file.path), {
          contentType: detected.mime,
          cacheControl: 'private, max-age=86400',
        });
        saved = await this.prisma.chatAttachment.create({
          data: {
            ...base,
            kind: 'FILE',
            storageKey,
            fileName: cleanFileName(file.originalname, detected.ext),
            mimeType: detected.mime,
            sizeBytes: file.size,
            sha256,
          },
        });
      }
      return attachmentDto(saved);
    } finally {
      await fsp.unlink(file.path).catch(() => undefined);
    }
  }

  /** Remove an upload from the composer. Only the uploader, only before it is sent. */
  async remove(user: JwtPayload, id: string) {
    const a = await this.prisma.chatAttachment.findFirst({
      where: { id, uploaderId: user.sub, status: 'PENDING' },
    });
    if (!a) throw new NotFoundException('No such upload');
    await this.prisma.chatAttachment.delete({ where: { id } });
    await this.deleteObjects(a);
    return { id, removed: true };
  }

  /**
   * The bytes behind a signed link. The link was minted only after the
   * conversation gate (message reads) or for the uploader (their own pending
   * upload), so the signature is the permission; this re-checks that the file
   * still belongs to a live message, or is still pending.
   */
  async open(id: string, variant: ChatFileVariant, exp: number, token: string) {
    if (!['full', 'preview', 'download'].includes(variant)) throw new NotFoundException();
    if (!verifyLink('chat-file', `${id}:${variant}`, exp, token)) {
      throw new ForbiddenException('This link has expired');
    }
    const a = await this.prisma.chatAttachment.findUnique({
      where: { id },
      include: { message: { select: { deletedAt: true } } },
    });
    if (!a) throw new NotFoundException();
    if (a.status === 'ATTACHED' && (!a.message || a.message.deletedAt))
      throw new NotFoundException();
    const key = variant === 'preview' && a.previewKey ? a.previewKey : a.storageKey;
    const obj = await this.storage.getStream(key);
    return { attachment: a, obj, variant };
  }

  /** Uploads nobody sent within a day: rows and objects both go. */
  async sweep(now = Date.now()): Promise<number> {
    const stale = await this.prisma.chatAttachment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now - PENDING_TTL_MS) } },
      take: 500,
    });
    for (const a of stale) {
      const gone = await this.prisma.chatAttachment.deleteMany({
        where: { id: a.id, status: 'PENDING' },
      });
      if (gone.count) await this.deleteObjects(a);
    }
    if (stale.length) this.logger.log(`chat.attachments.swept count=${stale.length}`);
    return stale.length;
  }

  private async deleteObjects(a: { storageKey: string; previewKey: string | null }) {
    await this.storage.delete(a.storageKey).catch(() => undefined);
    if (a.previewKey) await this.storage.delete(a.previewKey).catch(() => undefined);
  }

  private async readHead(filePath: string): Promise<Buffer> {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fh.read(buf, 0, 64, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(filePath)
        .on('data', (c) => h.update(c))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
  }
}

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { JwtPayload, Role } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { databaseReady } from '../common/testing/db-available';
import { avatarUrl, chatFileUrl, verifyLink } from '../common/signed-link';
import { AcademyService } from '../academy/academy.service';
import { StaffScopeService } from '../academy/staff-scope.service';
import { ConversationPolicy } from './conversation-policy';
import { ChatService } from './chat.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');

/**
 * Messenger (Phase 0B) against a real PostgreSQL: attachments, reactions,
 * read positions, sender identity, jumping to a quoted message — and above
 * all that none of it opens a door the conversation gate keeps shut.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;

/** An in-memory object store standing in for local disk / R2. */
const objects = new Map<string, { body: Buffer; contentType?: string }>();
const storage = {
  driver: 'local',
  async put(key: string, body: Buffer | Readable, opts?: { contentType?: string }) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const c of body) chunks.push(Buffer.from(c));
    objects.set(key, { body: Buffer.concat(chunks), contentType: opts?.contentType });
  },
  async getStream(key: string) {
    const o = objects.get(key);
    if (!o) throw new Error('missing');
    return {
      stream: Readable.from(o.body),
      contentLength: o.body.length,
      totalSize: o.body.length,
      contentType: o.contentType,
    };
  },
  async delete(key: string) {
    objects.delete(key);
  },
} as any;

const events: { userId: string; event: string; payload: any }[] = [];
const realtime = {
  emitToUser: (userId: string, event: string, payload: any) =>
    events.push({ userId, event, payload }),
  emitToThread: () => undefined,
} as any;
const notifications = { create: async () => ({}), upsertForThread: async () => ({}) } as any;

let chat: ChatService;
let files: ChatAttachmentsService;
let reactions: ChatReactionsService;

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, [
    'chatThread',
    'chatMessage',
    'chatAttachment',
    'chatReaction',
    'chatReadState',
  ]);
  chat = new ChatService(
    prisma,
    realtime,
    notifications,
    storage,
    new StaffScopeService(prisma, new AcademyService(prisma)),
    new ConversationPolicy(prisma, new StaffScopeService(prisma, new AcademyService(prisma))),
  );
  files = new ChatAttachmentsService(prisma, storage, chat);
  reactions = new ChatReactionsService(prisma, chat, realtime);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

async function world(n = 1) {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `c0b-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `c0b-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academy.create({
    data: { id: tp.id, slug: `c0b-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: tp.id, title: `Course ${k}`, status: 'PUBLISHED' },
  });
  const students = [];
  for (let i = 0; i < n; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `Student ${k}-${i}`, email: `c0b-s-${k}-${i}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    await prisma.enrollment.create({
      data: {
        studentId: sp.id,
        courseId: course.id,
        tenantId: tp.id,
        academyId: tp.id,
        status: 'ACTIVE',
      },
    });
    students.push({
      userId: u.id,
      studentId: sp.id,
      jwt: { sub: u.id, role: Role.STUDENT, sessionId: 's' } as JwtPayload,
    });
  }
  const teacher = {
    userId: tUser.id,
    tenantId: tp.id,
    jwt: { sub: tUser.id, role: Role.TEACHER, tenantId: tp.id, sessionId: 's' } as JwtPayload,
  };
  return { teacher, students };
}

/** A staged upload, as multer would leave it on disk. */
async function staged(name: string, bytes: Buffer) {
  const p = path.join(os.tmpdir(), `c0b-${randomUUID()}`);
  await fsp.writeFile(p, bytes);
  return { path: p, originalname: name, size: bytes.length };
}
const pngBytes = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#3355aa' } })
    .png()
    .toBuffer();
const pdfBytes = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const threadsOfPair = (tenantId: string, studentId: string) =>
  prisma.chatThread.count({ where: { tenantId, studentId } });

describe('attachments — uploading never creates a conversation', () => {
  it('a first-message upload creates no thread; Send creates exactly one and binds it', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];

    const up = await files.upload(teacher.jwt, await staged('notes.pdf', pdfBytes()), {
      studentId: s.studentId,
    });
    expect(up.kind).toBe('FILE');
    expect(up.mimeType).toBe('application/pdf');
    expect(await threadsOfPair(teacher.tenantId, s.studentId)).toBe(0);
    const row = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: up.id } });
    expect(row.status).toBe('PENDING');
    expect(row.threadId).toBeNull();
    expect(row.targetKey).toBe(`${teacher.tenantId}|${s.studentId}|S|U:${teacher.userId}`);

    const sent = await chat.sendMessage(teacher.jwt, {
      studentId: s.studentId,
      body: '',
      attachmentIds: [up.id],
    });
    expect(await threadsOfPair(teacher.tenantId, s.studentId)).toBe(1);
    expect(sent.message.attachments).toHaveLength(1);
    expect(sent.message.attachments![0].name).toBe('notes.pdf');
    const bound = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: up.id } });
    expect(bound).toMatchObject({
      status: 'ATTACHED',
      messageId: sent.message.id,
      threadId: sent.threadId,
    });
  });

  it('two simultaneous first sends WITH attachments still make one conversation', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const a = await files.upload(teacher.jwt, await staged('a.pdf', pdfBytes()), {
      studentId: s.studentId,
    });
    const b = await files.upload(s.jwt, await staged('b.png', await pngBytes()), {
      tenantId: teacher.tenantId,
    });
    const [x, y] = await Promise.all([
      chat.sendMessage(teacher.jwt, {
        studentId: s.studentId,
        body: 'from teacher',
        attachmentIds: [a.id],
      }),
      chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: '', attachmentIds: [b.id] }),
    ]);
    expect(x.threadId).toBe(y.threadId);
    expect(await threadsOfPair(teacher.tenantId, s.studentId)).toBe(1);
  });

  it('a send whose attachment is not bindable fails whole: no message, no thread', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(2);
    const [s1, s2] = students;
    // An upload meant for student 2's conversation…
    const other = await files.upload(teacher.jwt, await staged('x.pdf', pdfBytes()), {
      studentId: s2.studentId,
    });
    // …cannot ride along on a first message to student 1.
    await expect(
      chat.sendMessage(teacher.jwt, {
        studentId: s1.studentId,
        body: 'hi',
        attachmentIds: [other.id],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await threadsOfPair(teacher.tenantId, s1.studentId)).toBe(0);
    expect(
      (await prisma.chatAttachment.findUniqueOrThrow({ where: { id: other.id } })).status,
    ).toBe('PENDING');
  });

  it('someone else’s pending upload cannot be sent, even into a shared conversation', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const { threadId } = await chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: 'hi' });
    const teachersUpload = await files.upload(teacher.jwt, await staged('t.pdf', pdfBytes()), {
      threadId,
    });
    await expect(
      chat.sendMessage(s.jwt, { threadId, body: 'stolen', attachmentIds: [teachersUpload.id] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.chatMessage.count({ where: { threadId, body: 'stolen' } })).toBe(0);
  });

  it('an attachment cannot be sent twice', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const up = await files.upload(s.jwt, await staged('a.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    const first = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: '',
      attachmentIds: [up.id],
    });
    await expect(
      chat.sendMessage(s.jwt, { threadId: first.threadId, body: '', attachmentIds: [up.id] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a retried attachment send (same clientMessageId) is one message', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const up = await files.upload(s.jwt, await staged('a.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    const cid = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        chat
          .sendMessage(s.jwt, {
            tenantId: teacher.tenantId,
            body: '',
            attachmentIds: [up.id],
            clientMessageId: cid,
          })
          .catch((e) => e),
      ),
    );
    const ok = results.filter((r) => r && r.message);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((r: any) => r.message.id)).size).toBe(1);
    expect(
      await prisma.chatMessage.count({ where: { senderId: s.userId, clientMessageId: cid } }),
    ).toBe(1);
  });

  it('an outsider cannot upload into a conversation or at a student they do not teach', async () => {
    if (!guard()) return;
    const a = await world();
    const b = await world();
    const { threadId } = await chat.sendMessage(a.students[0].jwt, {
      tenantId: a.teacher.tenantId,
      body: 'hi',
    });
    await expect(
      files.upload(b.teacher.jwt, await staged('x.pdf', pdfBytes()), { threadId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      files.upload(b.teacher.jwt, await staged('x.pdf', pdfBytes()), {
        studentId: a.students[0].studentId,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('attachments — what a file is decides, not what it claims', () => {
  const up = async (name: string, bytes: Buffer) => {
    const { teacher, students } = await world();
    return files.upload(students[0].jwt, await staged(name, bytes), { tenantId: teacher.tenantId });
  };

  it('refuses SVG, HTML, executables and plain zips, whatever they are named', async () => {
    if (!guard()) return;
    await expect(
      up(
        'x.svg',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_TYPE' } });
    await expect(
      up('x.pdf', Buffer.from('<html><script>alert(1)</script></html>')),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_TYPE' } });
    await expect(up('setup.pdf', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'))).rejects.toMatchObject({
      response: { code: 'ATTACHMENT_TYPE' },
    });
    await expect(up('bundle.zip', Buffer.from('PK\x03\x04\x14\x00\x00\x00'))).rejects.toMatchObject(
      { response: { code: 'ATTACHMENT_TYPE' } },
    );
  });

  it('a PDF named .png is stored as the PDF it is', async () => {
    if (!guard()) return;
    const a = await up('photo.png', pdfBytes());
    expect(a).toMatchObject({ kind: 'FILE', mimeType: 'application/pdf', name: 'photo.pdf' });
  });

  it('re-encodes images and strips their metadata (EXIF)', async () => {
    if (!guard()) return;
    const jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#aa3355' },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: 'secret-location-marker' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const a = await up('camera.jpg', jpeg);
    expect(a).toMatchObject({ kind: 'IMAGE', mimeType: 'image/webp', width: 64, height: 48 });
    const row = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: a.id } });
    const stored = objects.get(row.storageKey)!.body;
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(stored.includes(Buffer.from('secret-location-marker'))).toBe(false);
  });

  it('display names are sanitised: no paths, no bidi tricks', async () => {
    if (!guard()) return;
    const a = await up('../../etc/‮fdp.exe.pdf', pdfBytes());
    expect(a.name).toBe('fdp.exe.pdf');
    // As multer actually delivers it: the UTF-8 bytes read as latin1.
    const arabic = Buffer.from('ملخص الدرس.pdf', 'utf8').toString('latin1');
    expect((await up(arabic, pdfBytes())).name).toBe('ملخص الدرس.pdf');
    const row = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.storageKey).toMatch(/^chat-files\/[a-z0-9]+\.pdf$/);
  });
});

describe('attachments — delivery and cleanup', () => {
  it('a signed link opens its own file only; tampered or mismatched links do not', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const a = await files.upload(students[0].jwt, await staged('a.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    const url = new URL(a.url, 'http://x');
    const [e, t, u] = [
      Number(url.searchParams.get('e')),
      url.searchParams.get('t')!,
      url.searchParams.get('u')!,
    ];
    expect(u).toBe(students[0].jwt.sub);
    await expect(files.open(a.id, 'full', e, t, u)).resolves.toMatchObject({ variant: 'full' });
    await expect(files.open(a.id, 'full', e, t.slice(0, -2) + 'xx', u)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(files.open(a.id, 'download', e, t, u)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(files.open(a.id, 'full', 1000, t, u)).rejects.toBeInstanceOf(ForbiddenException);
    // A link is its viewer's: replayed under someone else's id it opens nothing.
    await expect(files.open(a.id, 'full', e, t, teacher.jwt.sub)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // A token for one attachment never opens another.
    const b = await files.upload(students[0].jwt, await staged('b.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    await expect(files.open(b.id, 'full', e, t, u)).rejects.toBeInstanceOf(ForbiddenException);
    // Avatar and file tokens are not interchangeable.
    expect(verifyLink('avatar', `${a.id}:full`, e, t)).toBe(false);
    expect(chatFileUrl(a.id, 'full', u)).toContain(`/files/chat/${a.id}?v=full&u=${u}`);
  });

  it('a removed message takes its files with it', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const a = await files.upload(s.jwt, await staged('a.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    const sent = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'x',
      attachmentIds: [a.id],
    });
    await prisma.chatMessage.delete({ where: { id: sent.message.id } }); // soft delete
    const url = new URL(sent.message.attachments![0].url, 'http://x');
    await expect(
      files.open(
        a.id,
        'full',
        Number(url.searchParams.get('e')),
        url.searchParams.get('t')!,
        url.searchParams.get('u')!,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('only the uploader removes a pending upload; the sweep removes abandoned ones only', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const a = await files.upload(s.jwt, await staged('a.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    await expect(files.remove(teacher.jwt, a.id)).rejects.toMatchObject({ status: 404 });
    await files.remove(s.jwt, a.id);
    expect(await prisma.chatAttachment.count({ where: { id: a.id } })).toBe(0);

    const old = await files.upload(s.jwt, await staged('old.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    const kept = await files.upload(s.jwt, await staged('kept.pdf', pdfBytes()), {
      tenantId: teacher.tenantId,
    });
    await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: '',
      attachmentIds: [kept.id],
    });
    await prisma.chatAttachment.updateMany({
      where: { id: { in: [old.id, kept.id] } },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
    });
    const oldKey = (await prisma.chatAttachment.findUniqueOrThrow({ where: { id: old.id } }))
      .storageKey;
    await files.sweep();
    expect(await prisma.chatAttachment.count({ where: { id: old.id } })).toBe(0);
    expect(objects.has(oldKey)).toBe(false);
    expect(await prisma.chatAttachment.count({ where: { id: kept.id, status: 'ATTACHED' } })).toBe(
      1,
    );
  });
});

describe('reactions', () => {
  it('one reaction per person per message, even under 20 simultaneous taps', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const { message } = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'react to me',
    });
    const emojis = ['👍', '❤️', '😂', '😮'];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => reactions.react(teacher.jwt, message.id, emojis[i % 4])),
    );
    expect(
      await prisma.chatReaction.count({ where: { messageId: message.id, userId: teacher.userId } }),
    ).toBe(1);

    const mine = await reactions.react(s.jwt, message.id, '👍');
    expect(mine.reduce((n, r) => n + r.count, 0)).toBe(2);
    expect(mine.find((r) => r.emoji === '👍')?.mine).toBe(true);

    await reactions.unreact(teacher.jwt, message.id);
    const page = await chat.getMessages(s.jwt, message.threadId);
    expect(page.find((m) => m.id === message.id)?.reactions).toEqual([
      { emoji: '👍', count: 1, mine: true, names: [expect.any(String)] },
    ]);
  });

  it('pushes each participant their own view', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const { message } = await chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: 'x' });
    events.length = 0;
    await reactions.react(teacher.jwt, message.id, '❤️');
    const pushed = events.filter((e) => e.event === 'chat:reaction');
    expect(pushed.map((e) => e.userId).sort()).toEqual([s.userId, teacher.userId].sort());
    expect(pushed.find((e) => e.userId === teacher.userId)!.payload.reactions[0].mine).toBe(true);
    expect(pushed.find((e) => e.userId === s.userId)!.payload.reactions[0].mine).toBe(false);
  });

  it('refuses unknown emoji, and outsiders — the same way for a missing message', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(2);
    const { message } = await chat.sendMessage(students[0].jwt, {
      tenantId: teacher.tenantId,
      body: 'x',
    });
    await expect(reactions.react(teacher.jwt, message.id, '💩')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(reactions.react(students[1].jwt, message.id, '👍')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(reactions.react(students[1].jwt, 'does-not-exist', '👍')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(reactions.unreact(students[1].jwt, message.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(await prisma.chatReaction.count({ where: { messageId: message.id } })).toBe(0);
  });
});

describe('read positions and ✓✓', () => {
  it('unread follows the reader’s cursor; the sender sees ✓✓ once the other side read it', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const a = await chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: 'one' });
    await chat.sendMessage(teacher.jwt, { threadId: a.threadId, body: 'two' });

    let list = await chat.listThreads(s.jwt);
    expect(list[0].unread).toBe(2);
    let mine = await chat.getMessages(teacher.jwt, a.threadId, { before: undefined });
    expect(mine.every((m) => m.readAt === null)).toBe(true);

    events.length = 0;
    await chat.getMessages(s.jwt, a.threadId); // the student opens it
    expect(events.some((e) => e.event === 'chat:seen' && e.userId === teacher.userId)).toBe(true);
    list = await chat.listThreads(s.jwt);
    expect(list[0].unread).toBe(0);
    mine = await chat.getMessages(teacher.jwt, a.threadId);
    expect(mine.every((m) => m.readAt !== null)).toBe(true);
    expect((await chat.listThreads(teacher.jwt))[0].counterpartLastReadAt).not.toBeNull();
  });

  it('the cursor only moves forward, and scrolling back never moves it', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const first = await chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: 'one' });
    await chat.sendMessage(teacher.jwt, { threadId: first.threadId, body: 'two' });
    await chat.markReadUpTo(s.jwt, first.threadId);
    const high = await prisma.chatReadState.findUniqueOrThrow({
      where: { threadId_userId: { threadId: first.threadId, userId: s.userId } },
    });
    await chat.markReadUpTo(s.jwt, first.threadId, first.message.id); // an older point
    const after = await prisma.chatReadState.findUniqueOrThrow({
      where: { threadId_userId: { threadId: first.threadId, userId: s.userId } },
    });
    expect(after.lastReadAt.getTime()).toBe(high.lastReadAt.getTime());
  });

  it('another student cannot move someone else’s cursor', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(2);
    const a = await chat.sendMessage(teacher.jwt, { studentId: students[0].studentId, body: 'x' });
    await expect(chat.markReadUpTo(students[1].jwt, a.threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('identity, replies and jumping', () => {
  it('every message carries a frozen sender kind and a signed avatar URL, never image data', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    await prisma.user.update({
      where: { id: teacher.userId },
      data: { avatarUrl: `data:image/png;base64,${(await pngBytes()).toString('base64')}` },
    });
    const t = await chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: 'hi' });
    const r = await chat.sendMessage(s.jwt, { threadId: t.threadId, body: 'hello' });
    expect(t.message.sender).toMatchObject({ kind: 'OWNER', id: teacher.userId });
    expect(r.message.sender).toMatchObject({ kind: 'STUDENT', avatarUrl: null });
    expect(t.message.sender!.avatarUrl).toMatch(/\/files\/avatars\/.+\?v=.+&e=\d+&t=/);
    expect(t.message.sender!.avatarUrl!.startsWith('data:')).toBe(false);
    const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: t.message.id } });
    expect(stored.senderKind).toBe('OWNER');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } });
    expect(avatarUrl(u)).toBe(t.message.sender!.avatarUrl);
  });

  it('a reply to a removed message is shown as unavailable, not silently dropped', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const orig = await chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: 'original' });
    const reply = await chat.sendMessage(teacher.jwt, {
      threadId: orig.threadId,
      body: 're',
      replyToId: orig.message.id,
    });
    expect(reply.message.replyTo).toMatchObject({ id: orig.message.id, body: 'original' });
    await prisma.chatMessage.delete({ where: { id: orig.message.id } });
    const page = await chat.getMessages(teacher.jwt, orig.threadId);
    expect(page.find((m) => m.id === reply.message.id)?.replyTo).toMatchObject({
      id: orig.message.id,
      unavailable: true,
      body: '',
    });
  });

  it('a reply to an attachment says so', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const up = await files.upload(s.jwt, await staged('p.png', await pngBytes()), {
      tenantId: teacher.tenantId,
    });
    const photo = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: '',
      attachmentIds: [up.id],
    });
    const reply = await chat.sendMessage(teacher.jwt, {
      threadId: photo.threadId,
      body: 'nice',
      replyToId: photo.message.id,
    });
    expect(reply.message.replyTo).toMatchObject({ attachmentKind: 'IMAGE' });
  });

  it('`around` returns a window with the message in it, from deep history', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const { threadId } = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'm-000',
    });
    const base = Date.now() - 3600_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        threadId,
        senderId: i % 2 ? teacher.userId : s.userId,
        body: `m-${String(i + 1).padStart(3, '0')}`,
        createdAt: new Date(base + i * 1000),
      })),
    });
    const target = await prisma.chatMessage.findFirstOrThrow({
      where: { threadId, body: 'm-020' },
    });
    const win = await chat.getMessages(teacher.jwt, threadId, { around: target.id, limit: 20 });
    const bodies = win.map((m) => m.body);
    expect(bodies).toContain('m-020');
    expect(bodies.indexOf('m-020')).toBeGreaterThan(5);
    expect(win.length).toBeLessThanOrEqual(21);
    // Ordered and contiguous.
    expect(bodies).toEqual([...bodies].sort());
    // Another student cannot use `around` on it.
    const other = await world();
    await expect(
      chat.getMessages(other.students[0].jwt, threadId, { around: target.id }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

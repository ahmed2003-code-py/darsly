import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { JwtPayload, Role } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { databaseReady } from '../common/testing/db-available';
import { AcademyService } from '../academy/academy.service';
import { StaffScopeService } from '../academy/staff-scope.service';
import { ConversationPolicy } from './conversation-policy';
import { ChatService } from './chat.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');

/**
 * Messenger polish against a real PostgreSQL: one message carrying text,
 * voice and files together; delete for me; delete for everyone.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;

const objects = new Map<string, Buffer>();
const storage = {
  driver: 'local',
  async put(key: string, body: Buffer | Readable) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const c of body) chunks.push(Buffer.from(c));
    objects.set(key, Buffer.concat(chunks));
  },
  async getStream(key: string) {
    const o = objects.get(key);
    if (!o) throw new Error('missing');
    return { stream: Readable.from(o), contentLength: o.length, totalSize: o.length };
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
    'chatMessageHide',
    'membershipCourse',
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
const jwt = (sub: string, role: Role, tenantId?: string) =>
  ({ sub, role, tenantId, sessionId: 's' }) as JwtPayload;

/** A teacher, a student in their course, and an assistant for that course. */
async function world() {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `pol-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: {
      userId: tUser.id,
      slug: `pol-t-${k}`,
      status: 'APPROVED',
      acceptsStudentMessages: true,
    },
  });
  await prisma.academy.create({
    data: { id: tp.id, slug: `pol-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: tUser.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: tp.id, title: `Course ${k}`, status: 'PUBLISHED' },
  });
  const sUser = await prisma.user.create({
    data: { role: 'STUDENT', fullName: `Student ${k}`, email: `pol-s-${k}@it.test` },
  });
  const sp = await prisma.studentProfile.create({ data: { userId: sUser.id } });
  await prisma.enrollment.create({
    data: {
      studentId: sp.id,
      courseId: course.id,
      tenantId: tp.id,
      academyId: tp.id,
      status: 'ACTIVE',
    },
  });
  const aUser = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Assistant ${k}`, email: `pol-a-${k}@it.test` },
  });
  const m = await prisma.academyMembership.create({
    data: {
      userId: aUser.id,
      academyId: tp.id,
      role: 'ASSISTANT',
      status: 'ACTIVE',
      title: 'Student Support',
      courseScope: 'SELECTED',
      permissions: ['student.view', 'message.reply'],
    },
  });
  await prisma.membershipCourse.create({
    data: { membershipId: m.id, courseId: course.id, academyId: tp.id },
  });
  return {
    academyId: tp.id,
    teacher: { userId: tUser.id, tenantId: tp.id, jwt: jwt(tUser.id, Role.TEACHER, tp.id) },
    student: { userId: sUser.id, studentId: sp.id, jwt: jwt(sUser.id, Role.STUDENT) },
    assistant: { userId: aUser.id, jwt: jwt(aUser.id, Role.STAFF) },
  };
}

async function staged(name: string, bytes: Buffer) {
  const p = path.join(os.tmpdir(), `pol-${randomUUID()}`);
  await fsp.writeFile(p, bytes);
  return { path: p, originalname: name, size: bytes.length };
}
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000, 7)]);
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const png = () =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#3355aa' } })
    .png()
    .toBuffer();
const threadsOf = (studentId: string) => prisma.chatThread.count({ where: { studentId } });
/** Record a voice note in the composer: a pending upload, like any file. */
const voiceUp = async (u: JwtPayload, target: any, sec = 7) =>
  files.upload(u, await staged('voice.webm', webm()), target, { durationSec: sec });

describe('one message: text, voice and files together', () => {
  it('voice + image, voice + PDF, voice + several files, text + voice + file — each ONE message', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { studentId: w.student.studentId };
    const combos: { body: string; files: [string, () => Buffer | Promise<Buffer>][] }[] = [
      { body: '', files: [['p.png', png]] },
      { body: '', files: [['doc.pdf', pdf]] },
      {
        body: '',
        files: [
          ['a.pdf', pdf],
          ['b.png', png],
          ['c.pdf', pdf],
        ],
      },
      { body: 'اسمع ده وبص على الملف', files: [['notes.pdf', pdf]] },
    ];
    for (const c of combos) {
      const before = await prisma.chatMessage.count({ where: { senderId: w.teacher.userId } });
      const voice = await voiceUp(w.teacher.jwt, target);
      expect(voice.kind).toBe('VOICE');
      expect(voice.durationSec).toBe(7);
      const ups = [];
      for (const [name, bytes] of c.files) {
        ups.push(await files.upload(w.teacher.jwt, await staged(name, await bytes()), target));
      }
      const sent = await chat.sendMessage(w.teacher.jwt, {
        ...target,
        body: c.body,
        attachmentIds: [voice.id, ...ups.map((u) => u.id)],
      });
      expect(await prisma.chatMessage.count({ where: { senderId: w.teacher.userId } })).toBe(
        before + 1,
      );
      expect(sent.message.body).toBe(c.body);
      expect(sent.message.attachments!.map((a) => a.kind).sort()).toEqual(
        ['VOICE', ...ups.map((u) => u.kind)].sort(),
      );
      expect(sent.message.attachments!.find((a) => a.kind === 'VOICE')!.durationSec).toBe(7);
    }
    expect(await threadsOf(w.student.studentId)).toBe(1);
  });

  it('a voice-only message and an attachment-only message are fine', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { studentId: w.student.studentId };
    const v = await voiceUp(w.teacher.jwt, target);
    const a = await chat.sendMessage(w.teacher.jwt, { ...target, body: '', attachmentIds: [v.id] });
    expect(a.message.attachments).toHaveLength(1);
    const f = await files.upload(w.teacher.jwt, await staged('x.pdf', pdf()), {
      threadId: a.threadId,
    });
    const b = await chat.sendMessage(w.teacher.jwt, {
      threadId: a.threadId,
      body: '',
      attachmentIds: [f.id],
    });
    expect(b.message.attachments![0].kind).toBe('FILE');
  });

  it('first message: recording and uploading create NO conversation; Send creates exactly one', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { tenantId: w.teacher.tenantId };
    const v = await voiceUp(w.student.jwt, target, 4);
    const f = await files.upload(w.student.jwt, await staged('hw.pdf', pdf()), target);
    expect(await threadsOf(w.student.studentId)).toBe(0);
    const sent = await chat.sendMessage(w.student.jwt, {
      ...target,
      body: 'سؤال',
      attachmentIds: [v.id, f.id],
      clientMessageId: 'combo-first-0001',
    });
    expect(await threadsOf(w.student.studentId)).toBe(1);
    // A retry of the same send (same clientMessageId) is the same one message.
    const again = await chat.sendMessage(w.student.jwt, {
      ...target,
      body: 'سؤال',
      attachmentIds: [v.id, f.id],
      clientMessageId: 'combo-first-0001',
    });
    expect(again.message.id).toBe(sent.message.id);
    expect(await prisma.chatMessage.count({ where: { threadId: sent.threadId } })).toBe(1);
    expect(again.message.attachments).toHaveLength(2);
  });

  it('an abandoned recording and file make no conversation and are swept', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { tenantId: w.teacher.tenantId };
    const v = await voiceUp(w.student.jwt, target);
    await files.upload(w.student.jwt, await staged('left.pdf', pdf()), target);
    expect(await threadsOf(w.student.studentId)).toBe(0);
    await files.sweep(Date.now() + 25 * 3600 * 1000);
    expect(await prisma.chatAttachment.findUnique({ where: { id: v.id } })).toBeNull();
    expect(await threadsOf(w.student.studentId)).toBe(0);
  });

  it('refuses two voice notes in one message, and audio sent as an ordinary file', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { studentId: w.student.studentId };
    const a = await voiceUp(w.teacher.jwt, target);
    const b = await voiceUp(w.teacher.jwt, target);
    await expect(
      chat.sendMessage(w.teacher.jwt, { ...target, body: '', attachmentIds: [a.id, b.id] }),
    ).rejects.toMatchObject({ response: { code: 'TOO_MANY_VOICE' } });
    expect(await threadsOf(w.student.studentId)).toBe(0);
    await expect(
      files.upload(w.teacher.jwt, await staged('song.webm', webm()), target),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_TYPE' } });
    await expect(
      files.upload(w.teacher.jwt, await staged('fake.webm', pdf()), target, { durationSec: 3 }),
    ).rejects.toMatchObject({ response: { code: 'VOICE_FORMAT' } });
  });

  it('a reply to a combined message summarises it compactly', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { studentId: w.student.studentId };
    const v = await voiceUp(w.teacher.jwt, target);
    const f = await files.upload(w.teacher.jwt, await staged('الواجب.pdf', pdf()), target);
    const orig = await chat.sendMessage(w.teacher.jwt, {
      ...target,
      body: '',
      attachmentIds: [v.id, f.id],
    });
    const reply = await chat.sendMessage(w.student.jwt, {
      threadId: orig.threadId,
      body: 'تمام',
      replyToId: orig.message.id,
    });
    expect(reply.message.replyTo).toMatchObject({
      id: orig.message.id,
      isVoice: true,
      attachmentKind: 'FILE',
      attachmentName: 'الواجب.pdf',
      attachmentCount: 1,
    });
  });
});

describe('delete for me', () => {
  it('hides the message for the viewer only, persistently', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await chat.sendMessage(w.teacher.jwt, {
      studentId: w.student.studentId,
      body: 'one',
    });
    const b = await chat.sendMessage(w.teacher.jwt, { threadId: a.threadId, body: 'two' });
    events.length = 0;
    await chat.hideMessage(w.student.jwt, a.message.id);
    // Only the viewer's own tabs are told.
    expect(events.filter((e) => e.event === 'chat:deleted').map((e) => e.userId)).toEqual([
      w.student.userId,
    ]);
    const mine = await chat.getMessages(w.student.jwt, a.threadId);
    expect(mine.map((m) => m.id)).toEqual([b.message.id]);
    const theirs = await chat.getMessages(w.teacher.jwt, a.threadId);
    expect(theirs.map((m) => m.id)).toEqual([a.message.id, b.message.id]);
    // Idempotent, and anyone in the conversation may hide anyone's message.
    await chat.hideMessage(w.student.jwt, a.message.id);
    await chat.hideMessage(w.teacher.jwt, b.message.id);
    expect((await chat.getMessages(w.teacher.jwt, a.threadId)).map((m) => m.id)).toEqual([
      a.message.id,
    ]);
  });

  it('cannot hide a message in someone else’s conversation', async () => {
    if (!guard()) return;
    const w = await world();
    const x = await world();
    const a = await chat.sendMessage(w.teacher.jwt, { studentId: w.student.studentId, body: 'x' });
    await expect(chat.hideMessage(x.student.jwt, a.message.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('delete for everyone', () => {
  it('only the sender — student, teacher and assistant alike', async () => {
    if (!guard()) return;
    const w = await world();
    const t = await chat.sendMessage(w.teacher.jwt, {
      studentId: w.student.studentId,
      body: 'from teacher',
    });
    const s = await chat.sendMessage(w.student.jwt, { threadId: t.threadId, body: 'from student' });
    const na = NOT_SENDER;
    await expect(chat.revokeMessage(w.student.jwt, t.message.id)).rejects.toMatchObject(na);
    await expect(chat.revokeMessage(w.teacher.jwt, s.message.id)).rejects.toMatchObject(na);
    // The assistant's own conversation with the student.
    const a = await chat.sendMessage(w.assistant.jwt, {
      academyId: w.academyId,
      studentId: w.student.studentId,
      body: 'from assistant',
    });
    const sa = await chat.sendMessage(w.student.jwt, {
      threadId: a.threadId,
      body: 'to assistant',
    });
    await expect(chat.revokeMessage(w.assistant.jwt, sa.message.id)).rejects.toMatchObject(na);
    await expect(chat.revokeMessage(w.student.jwt, a.message.id)).rejects.toMatchObject(na);
    // …and nobody outside the conversation, sender or not.
    await expect(chat.revokeMessage(w.assistant.jwt, s.message.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Each sender can take back their own.
    await chat.revokeMessage(w.assistant.jwt, a.message.id);
    await chat.revokeMessage(w.student.jwt, s.message.id);
    await chat.revokeMessage(w.teacher.jwt, t.message.id);
  });

  it('leaves a tombstone: no body, no files, no voice, no reactions; replies say unavailable', async () => {
    if (!guard()) return;
    const w = await world();
    const target = { studentId: w.student.studentId };
    const v = await voiceUp(w.teacher.jwt, target);
    const f = await files.upload(w.teacher.jwt, await staged('secret.pdf', pdf()), target);
    const m = await chat.sendMessage(w.teacher.jwt, {
      ...target,
      body: 'the secret answer',
      attachmentIds: [v.id, f.id],
    });
    await reactions.react(w.student.jwt, m.message.id, '👍');
    const reply = await chat.sendMessage(w.student.jwt, {
      threadId: m.threadId,
      body: 'thanks',
      replyToId: m.message.id,
    });
    const links = m.message.attachments!.map((a) => new URL(a.url, 'http://x').searchParams);
    events.length = 0;
    await chat.revokeMessage(w.teacher.jwt, m.message.id);

    // Both sides are told at once.
    expect(
      events
        .filter((e) => e.event === 'chat:deleted')
        .map((e) => e.userId)
        .sort(),
    ).toEqual([w.student.userId, w.teacher.userId].sort());

    for (const viewer of [w.student.jwt, w.teacher.jwt]) {
      const page = await chat.getMessages(viewer, m.threadId);
      const tomb = page.find((x) => x.id === m.message.id)!;
      expect(tomb).toMatchObject({
        deleted: true,
        body: '',
        audio: null,
        attachments: [],
        reactions: [],
      });
      expect(JSON.stringify(tomb)).not.toContain('secret');
      expect(page.find((x) => x.id === reply.message.id)!.replyTo).toMatchObject({
        unavailable: true,
      });
    }
    // The files and the voice are gone behind every link already handed out.
    for (const [i, a] of m.message.attachments!.entries()) {
      await expect(
        files.open(a.id, 'full', Number(links[i].get('e')), links[i].get('t')!),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(reactions.react(w.student.jwt, m.message.id, '❤️')).rejects.toMatchObject({
      response: { code: 'MESSAGE_DELETED' },
    });
    // A new reply to it is not attached to it.
    const late = await chat.sendMessage(w.student.jwt, {
      threadId: m.threadId,
      body: 'late',
      replyToId: m.message.id,
    });
    expect(late.message.replyTo).toBeNull();
    // The list preview says deleted, not the text.
    const [th] = await chat.listThreads(w.student.jwt);
    expect(th.lastMessage).toBe('late');
    await chat.revokeMessage(w.student.jwt, late.message.id);
    const [th2] = await chat.listThreads(w.student.jwt);
    expect(th2.lastMessage).toContain('حذف');
  });

  it('a legacy voice note (old endpoint) is unavailable once deleted', async () => {
    if (!guard()) return;
    const w = await world();
    const first = await chat.sendMessage(w.teacher.jwt, {
      studentId: w.student.studentId,
      body: 'hi',
    });
    const v = await chat.sendVoiceNote(
      w.teacher.jwt,
      first.threadId,
      { buffer: webm(), mimetype: 'audio/webm' },
      3,
    );
    await expect(chat.voiceNote(w.student.jwt, v.message.id)).resolves.toBeTruthy();
    await chat.revokeMessage(w.teacher.jwt, v.message.id);
    await expect(chat.voiceNote(w.student.jwt, v.message.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

const NOT_SENDER = { response: { code: 'NOT_SENDER' } };

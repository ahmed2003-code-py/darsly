import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { databaseReady } from '../common/testing/db-available';
import { ChatService } from './chat.service';

/**
 * Chat against a real PostgreSQL — the guarantees here are the database's, so
 * a mock could only ever agree with whatever the code already believed.
 *
 *  - Simultaneous first messages from both sides land in ONE conversation.
 *  - A retried send (same clientMessageId) is stored once.
 *  - Opening a conversation creates nothing; the first message does.
 *  - History opens on the newest page and pages back with no gap and no
 *    duplicate, even while new messages keep arriving.
 *  - Another student, another teacher, or a cursor from another conversation
 *    gets nothing.
 *
 * Skips itself when no migrated database is reachable at DATABASE_URL.
 */
const prisma = new PrismaService();
let ready = false;
let chat: ChatService;

const realtime = { emitToUser: () => undefined, emitToThread: () => undefined } as any;
const notifications = { create: async () => ({}) } as any;
const storage = {} as any;

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['chatThread', 'chatMessage', 'enrollment']);
  chat = new ChatService(prisma, realtime, notifications, storage);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});

/** One teacher (with their academy and a course) and `n` students enrolled in it. */
async function world(n = 1) {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `chat-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `chat-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academy.create({
    data: { id: tp.id, slug: `chat-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: tp.id, title: `Course ${k}`, status: 'PUBLISHED' },
  });
  const students = [];
  for (let i = 0; i < n; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `Student ${k}-${i}`, email: `chat-s-${k}-${i}@it.test` },
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

const guard = () => ready;

describe('first message — one canonical conversation, whoever writes first', () => {
  it('50 simultaneous first sends from both sides create exactly one conversation', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];

    const results = await Promise.all(
      Array.from({ length: 25 }).flatMap((_, i) => [
        chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: `teacher ${i}` }),
        chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: `student ${i}` }),
      ]),
    );

    const threads = await prisma.chatThread.findMany({
      where: { tenantId: teacher.tenantId, studentId: s.studentId },
    });
    expect(threads).toHaveLength(1);
    expect(new Set(results.map((r) => r.threadId))).toEqual(new Set([threads[0].id]));
    expect(await prisma.chatMessage.count({ where: { threadId: threads[0].id } })).toBe(50);

    // The list pointer is the real newest message, whatever order commits landed in.
    const newest = await prisma.chatMessage.findFirst({
      where: { threadId: threads[0].id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(threads[0].lastMessageId).toBe(newest!.id);
    expect(threads[0].dedupeKey).toBe(`${teacher.tenantId}|${s.studentId}|S|U:${teacher.userId}`);
  });

  it('opening a conversation creates nothing; the first message does', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];

    const before = await chat.resolveTarget(teacher.jwt, { studentId: s.studentId });
    expect(before).toMatchObject({ threadId: null, counterpartName: expect.any(String) });
    expect(
      await prisma.chatThread.count({
        where: { tenantId: teacher.tenantId, studentId: s.studentId },
      }),
    ).toBe(0);

    const sent = await chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: 'Hi' });
    const after = await chat.resolveTarget(teacher.jwt, { studentId: s.studentId });
    expect(after.threadId).toBe(sent.threadId);
    // And the student resolving from their side reaches the same conversation.
    const fromStudent = await chat.resolveTarget(s.jwt, { tenantId: teacher.tenantId });
    expect(fromStudent.threadId).toBe(sent.threadId);
  });

  it('a first message that fails to save leaves no empty conversation behind', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];

    // The real transaction runs — the conversation is inserted and the message
    // with it — and then fails before commit, as a crash or a lost connection would.
    const original = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any) =>
      original(async (tx: any) => {
        await fn(tx);
        throw new Error('connection lost');
      })) as any);
    await expect(
      chat.sendMessage(teacher.jwt, { studentId: s.studentId, body: 'lost' }),
    ).rejects.toThrow('connection lost');
    spy.mockRestore();

    expect(
      await prisma.chatThread.count({
        where: { tenantId: teacher.tenantId, studentId: s.studentId },
      }),
    ).toBe(0);
    expect((await chat.resolveTarget(teacher.jwt, { studentId: s.studentId })).threadId).toBeNull();
  });
});

describe('retries — the same send is stored once', () => {
  it('ten parallel retries of one clientMessageId store one message', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const clientMessageId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: 'once', clientMessageId }),
      ),
    );

    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(await prisma.chatMessage.count({ where: { senderId: s.userId, clientMessageId } })).toBe(
      1,
    );
    expect(results[0].message.clientMessageId).toBe(clientMessageId);
  });

  it('a retry after the first attempt already succeeded returns the stored message', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const clientMessageId = randomUUID();

    const first = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'a',
      clientMessageId,
    });
    for (let i = 0; i < 5; i++) {
      const again = await chat.sendMessage(s.jwt, {
        threadId: first.threadId,
        body: 'a',
        clientMessageId,
      });
      expect(again.message.id).toBe(first.message.id);
    }
    expect(await prisma.chatMessage.count({ where: { threadId: first.threadId } })).toBe(1);
  });

  it('the same clientMessageId from two different senders is two messages', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    const s = students[0];
    const clientMessageId = randomUUID();

    const a = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'a',
      clientMessageId,
    });
    const b = await chat.sendMessage(teacher.jwt, {
      threadId: a.threadId,
      body: 'b',
      clientMessageId,
    });
    expect(a.message.id).not.toBe(b.message.id);
  });

  it('refuses a malformed clientMessageId on the path the HTTP pipe does not cover', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    await expect(
      chat.sendMessage(students[0].jwt, {
        tenantId: teacher.tenantId,
        body: 'a',
        clientMessageId: 'bad id!',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('history — newest first, keyset pages, no gaps, no duplicates', () => {
  /** A 500-message conversation; every third message shares a millisecond. */
  async function longThread() {
    const { teacher, students } = await world();
    const s = students[0];
    const { threadId } = await chat.sendMessage(s.jwt, {
      tenantId: teacher.tenantId,
      body: 'm-000',
    });
    const base = Date.now() - 10 * 60_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 499 }, (_, i) => ({
        threadId,
        senderId: i % 2 ? teacher.userId : s.userId,
        body: `m-${String(i + 1).padStart(3, '0')}`,
        createdAt: new Date(base + Math.floor(i / 3)),
      })),
    });
    // The seeded first message is newer than the bulk; give it the oldest slot
    // so body order and time order agree.
    await prisma.chatMessage.updateMany({
      where: { threadId, body: 'm-000' },
      data: { createdAt: new Date(base - 1) },
    });
    const all = await prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(all).toHaveLength(500);
    return { teacher, s, threadId, allIds: all.map((m) => m.id) };
  }

  it('opening a 500-message conversation returns the newest page, oldest-first for drawing', async () => {
    if (!guard()) return;
    const { teacher, threadId, allIds } = await longThread();

    const page = await chat.getMessages(teacher.jwt, threadId);
    expect(page).toHaveLength(40);
    expect(page.map((m) => m.id)).toEqual(allIds.slice(-40));
  });

  it('paging back reaches every one of the 500 messages exactly once, in order', async () => {
    if (!guard()) return;
    const { teacher, threadId, allIds } = await longThread();

    let page = await chat.getMessages(teacher.jwt, threadId, { limit: 37 });
    const seen = [...page.map((m) => m.id)];
    while (page.length) {
      page = await chat.getMessages(teacher.jwt, threadId, { before: page[0].id, limit: 37 });
      seen.unshift(...page.map((m) => m.id));
    }
    expect(seen).toEqual(allIds);
    expect(new Set(seen).size).toBe(500);
  });

  it('messages arriving while someone scrolls back shift nothing: no gap, no duplicate', async () => {
    if (!guard()) return;
    const { teacher, s, threadId, allIds } = await longThread();

    let page = await chat.getMessages(teacher.jwt, threadId);
    const newestSeen = page[page.length - 1].id;
    const older: string[] = [...page.map((m) => m.id)];
    const arrived: string[] = [];
    while (page.length) {
      // Someone keeps writing between every page fetch.
      const r = await chat.sendMessage(s.jwt, { threadId, body: `live ${arrived.length}` });
      arrived.push(r.message.id);
      page = await chat.getMessages(teacher.jwt, threadId, { before: page[0].id });
      older.unshift(...page.map((m) => m.id));
    }
    // Scrolling back saw exactly the history that existed when it started…
    expect(older).toEqual(allIds);
    // …and catching up after the newest message seen returns exactly what arrived.
    const caughtUp = await chat.getMessages(teacher.jwt, threadId, {
      after: newestSeen,
      limit: 100,
    });
    expect(caughtUp.map((m) => m.id)).toEqual(arrived);
    expect(new Set([...older, ...caughtUp.map((m) => m.id)]).size).toBe(500 + arrived.length);
  });

  it('refuses a cursor that belongs to another conversation', async () => {
    if (!guard()) return;
    const { teacher, s, threadId } = await longThread();
    const other = await world();
    const foreign = await chat.sendMessage(other.students[0].jwt, {
      tenantId: other.teacher.tenantId,
      body: 'elsewhere',
    });
    void s;
    await expect(
      chat.getMessages(teacher.jwt, threadId, { before: foreign.message.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('the list — bounded, newest activity first, correct unread counts', () => {
  it('pages the conversation list with a keyset cursor and counts unread per conversation', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(7);
    // Each student writes (i + 1) messages; later students write later.
    for (const [i, s] of students.entries()) {
      for (let j = 0; j <= i; j++) {
        await chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: `s${i} m${j}` });
      }
    }

    const first = await chat.listThreads(teacher.jwt, { limit: 3 });
    const second = await chat.listThreads(teacher.jwt, { limit: 3, before: first[2].id });
    const third = await chat.listThreads(teacher.jwt, { limit: 3, before: second[2].id });
    const all = [...first, ...second, ...third];

    expect(all).toHaveLength(7);
    expect(new Set(all.map((t) => t.id)).size).toBe(7);
    // Newest activity first: the last student to write is on top.
    expect(all.map((t) => t.studentId)).toEqual([...students].reverse().map((s) => s.studentId));
    // Student i wrote i + 1 messages, none read yet.
    for (const t of all) {
      const i = students.findIndex((s) => s.studentId === t.studentId);
      expect(t.unread).toBe(i + 1);
      expect(t.lastMessage).toBe(`s${i} m${i}`);
    }

    // Reading one conversation zeroes only that one.
    await chat.getMessages(teacher.jwt, first[0].id);
    const again = await chat.listThreads(teacher.jwt, { limit: 3 });
    expect(again[0].unread).toBe(0);
    expect(again[1].unread).toBe(first[1].unread);
  });

  it('a conversation with no message never shows in the list', async () => {
    if (!guard()) return;
    const { teacher, students } = await world();
    // The deprecated open path still creates a conversation for stale tabs…
    await chat.openThread(teacher.jwt, { studentId: students[0].studentId });
    // …which stays off the list until someone writes in it.
    expect(await chat.listThreads(teacher.jwt)).toHaveLength(0);
    await chat.sendMessage(students[0].jwt, { tenantId: teacher.tenantId, body: 'hi' });
    const list = await chat.listThreads(teacher.jwt);
    expect(list).toHaveLength(1);
    // And the send reused the conversation the old path made — one, not two.
    expect(
      await prisma.chatThread.count({
        where: { tenantId: teacher.tenantId, studentId: students[0].studentId },
      }),
    ).toBe(1);
  });

  it('a deep link to a conversation off the first page still gets its header', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(3);
    const sent = [];
    for (const s of students) {
      sent.push(await chat.sendMessage(s.jwt, { tenantId: teacher.tenantId, body: 'hi' }));
    }
    const page = await chat.listThreads(teacher.jwt, { limit: 1 });
    expect(page.map((t) => t.id)).not.toContain(sent[0].threadId);
    const header = await chat.getThread(teacher.jwt, sent[0].threadId);
    expect(header.id).toBe(sent[0].threadId);
    expect(header.unread).toBe(1);
  });
});

describe('isolation — nobody reaches a conversation that is not theirs', () => {
  it('another student cannot read, page, send into, or resolve into a conversation', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(2);
    const [owner, intruder] = students;
    const { threadId, message } = await chat.sendMessage(owner.jwt, {
      tenantId: teacher.tenantId,
      body: 'private',
    });

    await expect(chat.getMessages(intruder.jwt, threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      chat.getMessages(intruder.jwt, threadId, { before: message.id }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(chat.getThread(intruder.jwt, threadId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      chat.sendMessage(intruder.jwt, { threadId, body: 'let me in' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Resolving the teacher from the intruder's side lands on THEIR own (empty)
    // conversation with that teacher, never the owner's.
    const own = await chat.resolveTarget(intruder.jwt, { tenantId: teacher.tenantId });
    expect(own.threadId).toBeNull();
    expect(await prisma.chatMessage.count({ where: { threadId } })).toBe(1);
  });

  it('a teacher from another academy cannot read, send into, or start a conversation with the student', async () => {
    if (!guard()) return;
    const a = await world();
    const b = await world();
    const { threadId } = await chat.sendMessage(a.students[0].jwt, {
      tenantId: a.teacher.tenantId,
      body: 'for teacher A only',
    });

    await expect(chat.getMessages(b.teacher.jwt, threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      chat.sendMessage(b.teacher.jwt, { threadId, body: 'hello' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      chat.sendMessage(b.teacher.jwt, { studentId: a.students[0].studentId, body: 'hello' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      chat.resolveTarget(b.teacher.jwt, { studentId: a.students[0].studentId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await chat.listThreads(b.teacher.jwt)).toHaveLength(0);
  });

  it('a student cannot start a conversation with a teacher they are not enrolled with', async () => {
    if (!guard()) return;
    const a = await world();
    const b = await world();
    await expect(
      chat.sendMessage(a.students[0].jwt, { tenantId: b.teacher.tenantId, body: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      chat.resolveTarget(a.students[0].jwt, { tenantId: b.teacher.tenantId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await prisma.chatThread.count({
        where: { tenantId: b.teacher.tenantId, studentId: a.students[0].studentId },
      }),
    ).toBe(0);
  });

  it('a replayed clientMessageId is no way back into a conversation after losing access', async () => {
    if (!guard()) return;
    const { teacher, students } = await world(2);
    const [owner, intruder] = students;
    const clientMessageId = randomUUID();
    const { threadId } = await chat.sendMessage(owner.jwt, {
      tenantId: teacher.tenantId,
      body: 'mine',
      clientMessageId,
    });
    // Same client id, someone else's conversation: authorization runs first.
    await expect(
      chat.sendMessage(intruder.jwt, { threadId, body: 'x', clientMessageId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

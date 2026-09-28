import { ForbiddenException } from '@nestjs/common';
import { Role } from '@darsly/shared-types';
import { ChatService } from './chat.service';

/**
 * Who may read a conversation.
 *
 * `chat` was 624 lines with no spec at all, and it is the module where a
 * scoping mistake is a privacy incident rather than a bug: one teacher reading
 * another's messages with a student, or a student reading a thread that is not
 * theirs. `canAccessThread` is the single gate every read and write goes
 * through, so it is the thing worth pinning.
 *
 * These are unit tests over a stubbed Prisma on purpose: the question is which
 * branch of the authorization decides, and a real database would only make
 * that harder to see.
 */
const none = {} as any;

/** No staff memberships anywhere: the teacher/student paths only. */
const noScopes = { resolve: async () => null } as any;

function makeService(over: { thread?: unknown; studentId?: string | null } = {}) {
  const thread =
    over.thread === undefined
      ? {
          id: 't1',
          tenantId: 'teacherA',
          studentId: 'studentA',
          clearedForTeacherAt: null,
          clearedForStudentAt: null,
        }
      : over.thread;
  // The rest of a thread row the service reads (its parties), when present.
  const full = thread
    ? {
        dedupeKey: 'k',
        staffUserId: 'teacherUser',
        student: { userId: 'studentUser' },
        teacher: { userId: 'teacherUser' },
        ...(thread as object),
      }
    : thread;
  const prisma = {
    chatThread: {
      findUnique: jest.fn().mockResolvedValue(full),
      findUniqueOrThrow: jest.fn().mockResolvedValue(full),
      update: jest.fn().mockResolvedValue({}),
    },
    chatMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    chatReaction: { findMany: jest.fn().mockResolvedValue([]) },
    chatReadState: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { lastReadAt: null } }),
    },
    studentProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.studentId === undefined
            ? { id: 'studentA' }
            : over.studentId
              ? { id: over.studentId }
              : null,
        ),
    },
  } as any;
  return { svc: new ChatService(prisma, none, none, none, noScopes), prisma };
}

const user = (role: Role, over: Record<string, unknown> = {}) =>
  ({ sub: 'u1', role, tenantId: undefined, sessionId: 's1', ...over }) as any;

describe('ChatService.canAccessThread', () => {
  it('lets the student in the thread read it', async () => {
    const { svc } = makeService({ studentId: 'studentA' });

    await expect(svc.canAccessThread(user(Role.STUDENT), 't1')).resolves.toBe(true);
  });

  /**
   * The incident this prevents: a student opening someone else's conversation
   * by changing an id in a URL.
   */
  it('refuses a different student', async () => {
    const { svc } = makeService({ studentId: 'someone-else' });

    await expect(svc.canAccessThread(user(Role.STUDENT), 't1')).resolves.toBe(false);
  });

  it('refuses a user with no student profile at all', async () => {
    const { svc } = makeService({ studentId: null });

    await expect(svc.canAccessThread(user(Role.STUDENT), 't1')).resolves.toBe(false);
  });

  it('lets the thread’s own teacher read it', async () => {
    const { svc } = makeService();

    await expect(
      svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1'),
    ).resolves.toBe(true);
  });

  /** The other half of the same incident, between teachers. */
  it('refuses a teacher from another tenant', async () => {
    const { svc } = makeService();

    await expect(
      svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherB' }), 't1'),
    ).resolves.toBe(false);
  });

  /**
   * Defence in depth, not a live bug: `ChatThread.tenantId` is non-nullable so
   * such a thread cannot exist, and a TEACHER token always carries a tenant.
   * The reason to assert it anyway is that `undefined === undefined` is true,
   * so the comparison alone would hand a tenant-less token access to a
   * tenant-less thread the day either assumption stops holding.
   */
  it('refuses a teacher with no tenant, rather than matching undefined to undefined', async () => {
    const { svc } = makeService({
      thread: { id: 't1', tenantId: undefined, studentId: 'studentA' },
    });

    await expect(svc.canAccessThread(user(Role.TEACHER), 't1')).resolves.toBe(false);
  });

  it('refuses a thread that does not exist, rather than throwing', async () => {
    const { svc } = makeService({ thread: null });

    await expect(
      svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherA' }), 'ghost'),
    ).resolves.toBe(false);
  });

  /** Documented behaviour, pinned so it cannot change by accident. */
  it('lets SUPER_ADMIN read any thread', async () => {
    const { svc } = makeService({ studentId: null });

    await expect(svc.canAccessThread(user(Role.SUPER_ADMIN), 't1')).resolves.toBe(true);
  });
});

describe('ChatService — the gate is actually applied', () => {
  it('getMessages refuses a thread the caller cannot access', async () => {
    const { svc, prisma } = makeService({ studentId: 'someone-else' });

    await expect(svc.getMessages(user(Role.STUDENT), 't1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('clearThread refuses a thread the caller cannot access', async () => {
    const { svc, prisma } = makeService({ studentId: 'someone-else' });

    await expect(svc.clearThread(user(Role.STUDENT), 't1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.chatThread.update).not.toHaveBeenCalled();
  });

  /**
   * markThreadRead gates like the others but returns quietly instead of
   * throwing, and that is deliberate — the socket gateway calls it on every
   * thread open, where a rejection would be noise rather than information.
   * What matters is that it writes nothing.
   */
  it('markThreadRead writes nothing for a thread the caller cannot access', async () => {
    const { svc, prisma } = makeService({ studentId: 'someone-else' });

    await expect(svc.markThreadRead(user(Role.STUDENT), 't1')).resolves.toBeUndefined();
    expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
  });

  /**
   * "Cleared" is per side: a teacher clearing their view must not erase the
   * student's copy, and the filter that implements that has to be applied to
   * the read.
   */
  it('a cleared thread only returns messages after the clearing, for that side', async () => {
    const clearedAt = new Date('2026-01-01T00:00:00Z');
    const { svc, prisma } = makeService({
      studentId: 'studentA',
      thread: {
        id: 't1',
        tenantId: 'teacherA',
        studentId: 'studentA',
        clearedForStudentAt: clearedAt,
        clearedForTeacherAt: null,
      },
    });

    await svc.getMessages(user(Role.STUDENT), 't1');

    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: 't1', createdAt: { gt: clearedAt } } }),
    );
  });

  it('the teacher still sees everything when only the student cleared', async () => {
    const { svc, prisma } = makeService({
      thread: {
        id: 't1',
        tenantId: 'teacherA',
        studentId: 'studentA',
        clearedForStudentAt: new Date('2026-01-01T00:00:00Z'),
        clearedForTeacherAt: null,
      },
    });

    await svc.getMessages(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1');

    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { threadId: 't1' } }),
    );
  });

  /**
   * Opening a conversation reads the NEWEST page. It used to read the oldest
   * 200 in ascending order, so anything past the 200th message of a long
   * conversation never appeared at all.
   */
  it('caps a conversation read and takes it from the newest end', async () => {
    const { svc, prisma } = makeService();

    await svc.getMessages(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1');

    const args = prisma.chatMessage.findMany.mock.calls[0][0];
    expect(args.take).toBe(40);
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('never lets a client ask for an unbounded page', async () => {
    const { svc, prisma } = makeService();

    await svc.getMessages(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1', { limit: 1e9 });

    expect(prisma.chatMessage.findMany.mock.calls[0][0].take).toBe(100);
  });
});

/**
 * The conversation list costs the same number of queries for one conversation
 * as for a full page. It used to run one unread `count` per conversation, on
 * top of loading every conversation the viewer ever had.
 */
describe('ChatService.listThreads — bounded and not N+1', () => {
  function listPrisma(threadCount: number) {
    const threads = Array.from({ length: threadCount }, (_, i) => ({
      id: `t${i}`,
      type: 'DM',
      tenantId: 'teacherA',
      studentId: `s${i}`,
      lessonId: null,
      videoTimestampSec: null,
      lastMessageId: `m${i}`,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
      staffUserId: 'tu',
      teacher: { userId: 'tu', user: { id: 'tu', fullName: 'T', avatarUrl: null } },
      student: { userId: `su${i}`, user: { id: `su${i}`, fullName: `S${i}`, avatarUrl: null } },
    }));
    return {
      teacherProfile: { findUnique: jest.fn().mockResolvedValue({ acceptsStudentMessages: true }) },
      chatThread: {
        fields: { clearedForTeacherAt: 'ref-t', clearedForStudentAt: 'ref-s' },
        findMany: jest.fn().mockResolvedValue(threads),
        findFirst: jest.fn(),
      },
      chatMessage: {
        findMany: jest.fn().mockResolvedValue(
          threads.map((_, i) => ({
            id: `m${i}`,
            body: `hi ${i}`,
            audioKey: null,
            createdAt: new Date(),
          })),
        ),
        count: jest.fn(),
      },
      chatReadState: { findMany: jest.fn().mockResolvedValue([]) },
      academyMembership: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue(threads.map((t) => ({ threadId: t.id, unread: 2 }))),
    } as any;
  }

  const calls = (p: any) =>
    p.teacherProfile.findUnique.mock.calls.length +
    p.chatThread.findMany.mock.calls.length +
    p.chatThread.findFirst.mock.calls.length +
    p.chatMessage.findMany.mock.calls.length +
    p.chatMessage.count.mock.calls.length +
    p.chatReadState.findMany.mock.calls.length +
    p.academyMembership.findMany.mock.calls.length +
    p.$queryRaw.mock.calls.length;

  it('issues the same number of queries for 1 conversation as for 50', async () => {
    const one = listPrisma(1);
    const fifty = listPrisma(50);
    const teacher = user(Role.TEACHER, { tenantId: 'teacherA' });

    const a = await new ChatService(one, none, none, none, noScopes).listThreads(teacher);
    const b = await new ChatService(fifty, none, none, none, noScopes).listThreads(teacher);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(50);
    expect(calls(fifty)).toBe(calls(one));
    // Unread is one grouped query, never a count per conversation.
    expect(fifty.chatMessage.count).not.toHaveBeenCalled();
    expect(fifty.$queryRaw).toHaveBeenCalledTimes(1);
    expect(b.every((t) => t.unread === 2)).toBe(true);
  });

  it('asks the database for one page, never everything', async () => {
    const p = listPrisma(3);
    const teacher = user(Role.TEACHER, { tenantId: 'teacherA' });

    await new ChatService(p, none, none, none, noScopes).listThreads(teacher);
    expect(p.chatThread.findMany.mock.calls[0][0].take).toBe(50);

    await new ChatService(p, none, none, none, noScopes).listThreads(teacher, { limit: 5000 });
    expect(p.chatThread.findMany.mock.calls[1][0].take).toBe(100);
  });
});

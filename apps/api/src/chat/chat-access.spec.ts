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

function makeService(over: { thread?: unknown; studentId?: string | null } = {}) {
  const thread =
    over.thread === undefined
      ? { id: 't1', tenantId: 'teacherA', studentId: 'studentA', clearedForTeacherAt: null, clearedForStudentAt: null }
      : over.thread;
  const prisma = {
    chatThread: {
      findUnique: jest.fn().mockResolvedValue(thread),
      findUniqueOrThrow: jest.fn().mockResolvedValue(thread),
      update: jest.fn().mockResolvedValue({}),
    },
    chatMessage: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({}) },
    studentProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(over.studentId === undefined ? { id: 'studentA' } : over.studentId ? { id: over.studentId } : null),
    },
  } as any;
  return { svc: new ChatService(prisma, none, none, none), prisma };
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

    await expect(svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1')).resolves.toBe(true);
  });

  /** The other half of the same incident, between teachers. */
  it('refuses a teacher from another tenant', async () => {
    const { svc } = makeService();

    await expect(svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherB' }), 't1')).resolves.toBe(false);
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

    await expect(svc.canAccessThread(user(Role.TEACHER, { tenantId: 'teacherA' }), 'ghost')).resolves.toBe(false);
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

    await expect(svc.getMessages(user(Role.STUDENT), 't1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('clearThread refuses a thread the caller cannot access', async () => {
    const { svc, prisma } = makeService({ studentId: 'someone-else' });

    await expect(svc.clearThread(user(Role.STUDENT), 't1')).rejects.toBeInstanceOf(ForbiddenException);
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

  it('caps a conversation read rather than returning all of it', async () => {
    const { svc, prisma } = makeService();

    await svc.getMessages(user(Role.TEACHER, { tenantId: 'teacherA' }), 't1');

    expect(prisma.chatMessage.findMany.mock.calls[0][0].take).toBe(200);
  });
});

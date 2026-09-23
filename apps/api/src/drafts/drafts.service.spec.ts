import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DraftScope, DraftsService } from './drafts.service';

const scope: DraftScope = {
  academyId: 'acad1',
  authorTenantId: 'teacher1',
  manageAll: false,
  userId: 'user1',
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  academyId: 'acad1',
  tenantId: 'teacher1',
  createdBy: 'user1',
  kind: 'LESSON',
  scopeKey: 'lesson:l1',
  courseId: 'c1',
  lessonId: 'l1',
  label: 'الدرس الثالث',
  step: 'details',
  data: { title: 'الدرس الثالث' },
  createdAt: new Date('2026-09-20T10:00:00Z'),
  updatedAt: new Date('2026-09-20T10:00:00Z'),
  ...over,
});

/**
 * Work a teacher has not finished, and who is allowed to see it.
 *
 * A draft is an unpublished lesson with somebody's name on it, so the tenancy
 * rules here are the ones courses use and are tested the same way. Nothing in
 * this file reaches a database.
 */
describe('keeping half-finished work', () => {
  let prisma: any;
  let service: DraftsService;

  beforeEach(() => {
    prisma = {
      contentDraft: {
        upsert: jest.fn().mockResolvedValue(row()),
        findUnique: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([row()]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paperImport: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new DraftsService(prisma as PrismaService);
  });

  const save = (over: Record<string, unknown> = {}) =>
    service.save(scope, {
      kind: 'LESSON' as never,
      scopeKey: 'lesson:l1',
      courseId: 'c1',
      lessonId: 'l1',
      label: 'الدرس الثالث',
      step: 'details',
      data: { title: 'الدرس الثالث' },
      ...over,
    });

  it('writes one row per form, however many times it is saved', async () => {
    // The point of the unique key. A form autosaving every few seconds over a
    // twenty-minute write-up would otherwise leave hundreds of rows, and the
    // drafts list would be unusable the first time anybody wrote a lesson.
    await save();
    await save({ data: { title: 'الدرس الثالث المعدل' } });

    expect(prisma.contentDraft.upsert).toHaveBeenCalledTimes(2);
    for (const call of prisma.contentDraft.upsert.mock.calls) {
      expect(call[0].where).toEqual({
        tenantId_scopeKey: { tenantId: 'teacher1', scopeKey: 'lesson:l1' },
      });
    }
  });

  it('stamps the draft with the academy and the person typing, not the body', async () => {
    await save();

    const { create } = prisma.contentDraft.upsert.mock.calls[0][0];
    expect(create.academyId).toBe('acad1');
    expect(create.tenantId).toBe('teacher1');
    expect(create.createdBy).toBe('user1');
  });

  it('refuses a draft too large to be a form', async () => {
    // A form's state is a few kilobytes. Anything approaching a quarter of a
    // megabyte is a caller putting a file in it, and storing that would make
    // every drafts list slow for everyone in the academy.
    await expect(save({ data: { blob: 'x'.repeat(300_000) } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.contentDraft.upsert).not.toHaveBeenCalled();
  });

  it('will not save for an account with no teacher to own the draft', async () => {
    await expect(
      service.save(
        { ...scope, authorTenantId: undefined },
        {
          kind: 'LESSON' as never,
          scopeKey: 'lesson:l1',
          data: {},
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers "is there anything saved" with null rather than an error', async () => {
    prisma.contentDraft.findUnique.mockResolvedValue(null);

    await expect(service.find(scope, 'lesson:l1')).resolves.toBeNull();
  });

  it('does not hand a draft to somebody in another academy', async () => {
    // The unique key is (tenant, scopeKey) and carries no academy, so the row
    // that comes back has to be checked rather than trusted.
    prisma.contentDraft.findUnique.mockResolvedValue(row({ academyId: 'someone-else' }));

    await expect(service.find(scope, 'lesson:l1')).resolves.toBeNull();
  });

  it('lists only my own work, unless I own the academy', async () => {
    await service.list(scope);
    expect(prisma.contentDraft.findMany.mock.calls[0][0].where.tenantId).toBe('teacher1');

    prisma.contentDraft.findMany.mockClear();
    await service.list({ ...scope, manageAll: true });
    expect(prisma.contentDraft.findMany.mock.calls[0][0].where.tenantId).toBeUndefined();
  });

  it('puts an unfinished studio session on the same list', async () => {
    // Two tables, one question. A teacher who photographed an exam an hour ago
    // and a teacher who half-wrote a lesson are both asking "where was I".
    prisma.paperImport.findMany.mockResolvedValue([
      {
        id: 'imp1',
        title: 'امتحان الجبر',
        status: 'REVIEW',
        stage: 'READY',
        kind: 'PAPER',
        courseId: 'c1',
        progressDone: 4,
        progressTotal: 4,
        updatedAt: new Date('2026-09-21T10:00:00Z'),
      },
    ]);

    const list = await service.list(scope);

    const session = list.find((d) => d.kind === 'EXAM_STUDIO');
    expect(session?.id).toBe('imp1');
    expect(session?.status).toBe('REVIEW');
    expect(session?.progress).toEqual({ done: 4, total: 4 });
    // Newest first, across both sources.
    expect(list[0].id).toBe('imp1');
  });

  it('leaves a finished session off it — that is an exam, not a draft', async () => {
    await service.list(scope);

    const { status } = prisma.paperImport.findMany.mock.calls[0][0].where;
    expect(status.in).not.toContain('COMPLETED');
    expect(status.in).not.toContain('CANCELED');
    expect(status.in).toContain('REVIEW');
  });

  it('narrows to one course when the course screen asks', async () => {
    await service.list(scope, 'c1');

    expect(prisma.contentDraft.findMany.mock.calls[0][0].where.courseId).toBe('c1');
    expect(prisma.paperImport.findMany.mock.calls[0][0].where.courseId).toBe('c1');
  });

  it('deletes only the caller’s own draft, by key', async () => {
    await service.discard(scope, 'lesson:l1');

    // Two deleteMany calls happen on a list; this one is the discard.
    const call = prisma.contentDraft.deleteMany.mock.calls.at(-1)[0];
    expect(call.where).toEqual({
      tenantId: 'teacher1',
      scopeKey: 'lesson:l1',
      academyId: 'acad1',
    });
  });

  it('still lists drafts when the tidy-up of old ones fails', async () => {
    // The purge is housekeeping. A teacher who cannot see their work because a
    // delete failed is a far worse outcome than a month-old row surviving.
    prisma.contentDraft.deleteMany.mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(service.list(scope)).resolves.toHaveLength(1);
  });
});

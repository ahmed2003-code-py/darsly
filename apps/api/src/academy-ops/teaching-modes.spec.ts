import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScheduleConflictError, SessionsService } from './sessions.service';

function makeDeps() {
  const prisma: any = {
    groupSession: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })), update: jest.fn(async ({ data }: any) => ({ id: 's1', ...data })) },
    room: { findFirst: jest.fn().mockResolvedValue({ id: 'r1', academyId: 'a1', status: 'ACTIVE' }) },
    groupAssignment: { findFirst: jest.fn().mockResolvedValue({ id: 'ga' }), findMany: jest.fn().mockResolvedValue([]) },
    groupMembership: { findMany: jest.fn().mockResolvedValue([]) },
    liveSession: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  };
  const audit: any = { log: jest.fn() };
  const access: any = { assertGroupAccess: jest.fn().mockResolvedValue({ id: 'g1', academyId: 'a1' }) };
  const academy: any = { assertAssignableTeacher: jest.fn(async (_a: string, userId: string) => ({ userId, teacherProfileId: `tp_${userId}` })) };
  return { prisma, audit, access, academy, svc: new SessionsService(prisma, access, audit, academy) };
}
const ctx = (over: Record<string, unknown> = {}) => ({ academyId: 'a1', userId: 'owner1', role: 'OWNER', status: 'ACTIVE', isPlatformAdmin: false, can: () => true, ...over }) as any;
const T = { startAt: '2026-11-01T10:00:00Z', endAt: '2026-11-01T11:00:00Z' };

describe('teaching mode + location — data on the occurrence, never a role', () => {
  it('PHYSICAL with a room: location defaults to CENTER', async () => {
    const { svc, prisma } = makeDeps();
    await svc.create(ctx(), 'g1', { ...T, roomId: 'r1' });
    expect(prisma.groupSession.create.mock.calls[0][0].data).toMatchObject({ mode: 'PHYSICAL', locationType: 'CENTER', joinUrl: null });
  });
  it('PHYSICAL without a room needs a location type', async () => {
    const { svc } = makeDeps();
    await expect(svc.create(ctx(), 'g1', { ...T })).rejects.toMatchObject({ response: { code: 'LOCATION_REQUIRED' } });
  });
  it('PHYSICAL at the student\'s place: no room, note kept, no join link stored', async () => {
    const { svc, prisma } = makeDeps();
    await svc.create(ctx(), 'g1', { ...T, mode: 'PHYSICAL', locationType: 'STUDENT', locationNote: 'Nasr City', joinUrl: 'https://x.test' });
    expect(prisma.groupSession.create.mock.calls[0][0].data).toMatchObject({ mode: 'PHYSICAL', locationType: 'STUDENT', locationNote: 'Nasr City', joinUrl: null });
  });
  it('a room with a non-CENTER location is contradictory', async () => {
    const { svc } = makeDeps();
    await expect(svc.create(ctx(), 'g1', { ...T, roomId: 'r1', locationType: 'TEACHER' })).rejects.toMatchObject({ response: { code: 'ROOM_NEEDS_CENTER_LOCATION' } });
  });
  it('ONLINE needs online access (join link)', async () => {
    const { svc } = makeDeps();
    await expect(svc.create(ctx(), 'g1', { ...T, mode: 'ONLINE' })).rejects.toMatchObject({ response: { code: 'ONLINE_ACCESS_REQUIRED' } });
  });
  it('ONLINE with a join link: no location, no room', async () => {
    const { svc, prisma } = makeDeps();
    await svc.create(ctx(), 'g1', { ...T, mode: 'ONLINE', joinUrl: 'https://meet.test/x' });
    expect(prisma.groupSession.create.mock.calls[0][0].data).toMatchObject({ mode: 'ONLINE', locationType: null, roomId: null, joinUrl: 'https://meet.test/x' });
  });
  it('ONLINE with a physical location or room is refused', async () => {
    const { svc } = makeDeps();
    await expect(svc.create(ctx(), 'g1', { ...T, mode: 'ONLINE', joinUrl: 'https://m.test', locationType: 'CENTER' })).rejects.toMatchObject({ response: { code: 'ONLINE_HAS_LOCATION' } });
    await expect(svc.create(ctx(), 'g1', { ...T, mode: 'ONLINE', joinUrl: 'https://m.test', roomId: 'r1' })).rejects.toMatchObject({ response: { code: 'ONLINE_HAS_LOCATION' } });
  });
  it('ONLINE is satisfied by a LiveSession already scheduled for the group in the window (derived link, no FK)', async () => {
    const { svc, prisma } = makeDeps();
    prisma.liveSession.findFirst.mockResolvedValue({ startsAt: new Date('2026-11-01T10:00:00Z'), durationMin: 60 });
    await svc.create(ctx(), 'g1', { ...T, mode: 'ONLINE' });
    expect(prisma.liveSession.findFirst.mock.calls[0][0].where).toMatchObject({ groupId: 'g1' });
    expect(prisma.groupSession.create.mock.calls[0][0].data).toMatchObject({ mode: 'ONLINE', joinUrl: null });
  });
  it('HYBRID needs both a location and online access', async () => {
    const { svc, prisma } = makeDeps();
    await expect(svc.create(ctx(), 'g1', { ...T, mode: 'HYBRID', joinUrl: 'https://m.test' })).rejects.toMatchObject({ response: { code: 'LOCATION_REQUIRED' } });
    await expect(svc.create(ctx(), 'g1', { ...T, mode: 'HYBRID', roomId: 'r1' })).rejects.toMatchObject({ response: { code: 'ONLINE_ACCESS_REQUIRED' } });
    await svc.create(ctx(), 'g1', { ...T, mode: 'HYBRID', roomId: 'r1', joinUrl: 'https://m.test' });
    expect(prisma.groupSession.create.mock.calls[0][0].data).toMatchObject({ mode: 'HYBRID', locationType: 'CENTER', roomId: 'r1', joinUrl: 'https://m.test' });
  });
});

describe('teacher assignment — validated, never trusted', () => {
  it('runs the shared assignable-teacher check against the ACTIVE academy, then the group assignment', async () => {
    const { svc, academy, prisma } = makeDeps();
    await svc.create(ctx(), 'g1', { ...T, roomId: 'r1', teacherUserId: 'tA' });
    expect(academy.assertAssignableTeacher).toHaveBeenCalledWith('a1', 'tA');
    expect(prisma.groupAssignment.findFirst).toHaveBeenCalledWith({ where: { groupId: 'g1', userId: 'tA' } });
  });
  it('an ineligible teacher (STAFF / student / unapproved / other Center) is refused before any conflict check', async () => {
    const { svc, academy, prisma } = makeDeps();
    academy.assertAssignableTeacher.mockRejectedValue(new BadRequestException({ code: 'TEACHER_NOT_MEMBER' }));
    await expect(svc.create(ctx(), 'g1', { ...T, roomId: 'r1', teacherUserId: 'foreign' })).rejects.toMatchObject({ response: { code: 'TEACHER_NOT_MEMBER' } });
    expect(prisma.groupSession.create).not.toHaveBeenCalled();
  });
  it('an OWNER who is a teacher may take their own group unassigned, but still passes the identity check', async () => {
    const { svc, academy, prisma } = makeDeps();
    prisma.groupAssignment.findFirst.mockResolvedValue(null);
    await svc.create(ctx({ userId: 'owner1' }), 'g1', { ...T, roomId: 'r1', teacherUserId: 'owner1' });
    expect(academy.assertAssignableTeacher).toHaveBeenCalledWith('a1', 'owner1');
  });
});

describe('conflicts across both tables', () => {
  it('a live stream of the same teacher in the window blocks a physical slot', async () => {
    const { svc, prisma } = makeDeps();
    prisma.liveSession.findMany.mockResolvedValue([{ id: 'L', academyId: 'a1', startsAt: new Date('2026-11-01T10:30:00Z'), durationMin: 60 }]);
    const err = await svc.create(ctx(), 'g1', { ...T, roomId: 'r1', teacherUserId: 'tA' }).catch((e) => e);
    expect(err).toBeInstanceOf(ScheduleConflictError);
    expect(err.code).toBe('TEACHER_CONFLICT');
    expect(err.conflictingSessionId).toBe('L');
  });
  it('a collision in ANOTHER academy is reported by kind only — its id is never revealed', async () => {
    const { svc, prisma } = makeDeps();
    prisma.groupSession.findFirst.mockResolvedValue({ id: 'secret', academyId: 'centerB' });
    const err = await svc.create(ctx(), 'g1', { ...T, roomId: 'r1', teacherUserId: 'tA' }).catch((e) => e);
    expect(err.code).toBe('GROUP_CONFLICT');
    expect(err.conflictingSessionId).toBeUndefined();
  });
  it('a non-overlapping live stream does not conflict', async () => {
    const { svc, prisma } = makeDeps();
    prisma.liveSession.findMany.mockResolvedValue([{ id: 'L', academyId: 'a1', startsAt: new Date('2026-11-01T08:00:00Z'), durationMin: 60 }]);
    await expect(svc.create(ctx(), 'g1', { ...T, roomId: 'r1', teacherUserId: 'tA' })).resolves.toBeDefined();
  });
});

describe('scope', () => {
  it('a session of another academy 404s on update — the query is clamped to ctx.academyId', async () => {
    const { svc, prisma } = makeDeps();
    prisma.groupSession.findFirst.mockResolvedValue(null);
    await expect(svc.update(ctx(), 'foreign', { startAt: T.startAt })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.groupSession.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'foreign', academyId: 'a1' });
  });
  it('Center schedule: every query is clamped to the academy and live streams are role-scoped', async () => {
    const { svc, prisma } = makeDeps();
    prisma.groupAssignment.findMany.mockResolvedValue([{ groupId: 'g1' }]);
    await svc.schedule(ctx({ role: 'TEACHER', userId: 'tA' }), new Date('2026-11-01'), new Date('2026-11-08'));
    expect(prisma.groupSession.findMany.mock.calls[0][0].where).toMatchObject({ academyId: 'a1', groupId: { in: ['g1'] } });
    const liveWhere = prisma.liveSession.findMany.mock.calls[0][0].where;
    expect(liveWhere.academyId).toBe('a1');
    expect(liveWhere.OR).toEqual([{ teacherUserId: 'tA' }, { groupId: { in: ['g1'] } }]);
  });
  it('My Schedule is keyed on the teacher across every academy — both tables, nobody else', async () => {
    const { svc, prisma } = makeDeps();
    prisma.groupSession.findMany.mockResolvedValue([{ id: 'g', startAt: new Date('2026-11-02T10:00:00Z'), endAt: new Date('2026-11-02T11:00:00Z'), academyId: 'a1' }]);
    prisma.liveSession.findMany.mockResolvedValue([{ id: 'l', title: 'x', startsAt: new Date('2026-11-01T10:00:00Z'), durationMin: 60, status: 'SCHEDULED', groupId: null, teacherUserId: 'tA', joinUrl: null, academyId: 'centerB', academy: { id: 'centerB', name: 'B', slug: 'b', kind: 'CENTER' } }]);
    const out = await svc.mySchedule('tA', new Date('2026-11-01'), new Date('2026-11-08'));
    expect(prisma.groupSession.findMany.mock.calls[0][0].where).toMatchObject({ teacherUserId: 'tA' });
    expect(prisma.liveSession.findMany.mock.calls[0][0].where).toMatchObject({ teacherUserId: 'tA' });
    expect(out.map((e) => [e.kind, e.academyId])).toEqual([['LIVE', 'centerB'], ['GROUP', 'a1']]);
  });
});

import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AuditService } from '../audit/audit.service';
import { generateStudentCode } from '../center-students/student-code';
import { ClassAttendanceService } from '../class-ops/class-attendance.service';
import { ClassScheduleService } from '../class-ops/class-schedule.service';
import { databaseReady } from '../common/testing/db-available';
import { VALIDATION_PIPE_OPTIONS } from '../common/errors/validation-exception.factory';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { generateCardToken, hashCardToken } from './card-token';
import { DeskController } from './desk.controller';
import { DeskService, MISS_LIMIT } from './desk.service';
import { DeskCheckInDto } from './dto';

/**
 * Center Operations C3 against a real PostgreSQL. The one-active-card index,
 * the hash-only CHECK, the card guard trigger, C2's row lock on the class and
 * the card row locks are all part of what is under test; every race below is
 * two real transactions on two real connections.
 *
 * The world: Center A (Cairo) with an owner, a teacher on group A, a
 * receptionist holding the Reception preset with the desk (C1 + desk.checkin
 * + card.manage), and register students; Center B with its own owner and
 * student. studentRegistry, classOperations and receptionDesk are on for both.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
delete process.env.REDIS_URL; // the per-process miss counter; Redis is exercised in production
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const audit = new AuditService(prisma);
const flags = new FeatureFlagsService(prisma);
const access = new AcademyOpsAccessService(prisma);
const schedule = new ClassScheduleService(prisma, access, audit, academy);
const classes = new ClassAttendanceService(prisma, access, audit, schedule);
const desk = new DeskService(prisma, classes, schedule, flags, audit, new RedisService());

const MIN = 60_000;
const RECEPTION = [
  'student.view',
  'student.directory',
  'student.register',
  'desk.checkin',
  'card.manage',
];

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['academyStudentCard', 'groupSession', 'attendanceRecord']);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role) => ({ sub, role, sessionId: 's' }) as JwtPayload;
const ctxOf = async (userId: string, role: Role, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(userId, academyId, role))!;

async function makeStudent(academyId: string, name: string) {
  const u = await prisma.user.create({ data: { role: 'STUDENT', fullName: name } });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  const rec = await prisma.academyStudent.create({
    data: {
      academyId,
      studentId: sp.id,
      code: generateStudentCode(),
      fullName: name,
      source: 'DESK',
    },
  });
  return { studentId: sp.id, id: rec.id, code: rec.code };
}

/**
 * A fixed-offset zone where it is about noon right now. The desk works on the
 * academy's local TODAY, and these tests place classes up to ~3 hours either
 * side of now — run near midnight in Cairo, "later today" would be tomorrow.
 * Academy.timezone is a real setting, so this exercises the product's own
 * time-zone handling rather than faking a clock.
 */
function middayZone() {
  const off = ((12 - new Date().getUTCHours() + 36) % 24) - 12; // -12..+11
  return off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
}

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c3-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c3-${tag}-${k}`,
      name: `C3 ${tag} ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
      timezone: middayZone(),
    },
  });
  await prisma.academyMembership.create({
    data: { userId: owner.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  for (const f of ['studentRegistry', 'classOperations', 'receptionDesk'] as const)
    await flags.setFlag(acad.id, f, true, owner.id);
  const gA = await prisma.group.create({
    data: { academyId: acad.id, name: `A ${tag}`, lateGraceMin: 10 },
  });
  const gB = await prisma.group.create({ data: { academyId: acad.id, name: `B ${tag}` } });
  return { acad, ownerId: owner.id, gA, gB };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const A = await makeCenter(k, 'a');
  const B = await makeCenter(k, 'b');
  const t = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `c3-t-${k}@it.test` },
  });
  await prisma.teacherProfile.create({
    data: { userId: t.id, slug: `c3-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academyMembership.create({
    data: { userId: t.id, academyId: A.acad.id, role: 'TEACHER', status: 'ACTIVE' },
  });
  await prisma.groupAssignment.create({
    data: { groupId: A.gA.id, userId: t.id, role: 'TEACHER', academyId: A.acad.id },
  });
  const staff = async (tag: string, permissions: string[]) => {
    const u = await prisma.user.create({
      data: { role: 'STAFF', fullName: `${tag} ${k}`, email: `c3-${tag}-${k}@it.test` },
    });
    await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: A.acad.id,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        courseScope: 'ALL',
        permissions,
      },
    });
    return u.id;
  };
  const receptionId = await staff('r', RECEPTION);
  const reception2Id = await staff('r2', RECEPTION);
  const c1OnlyId = await staff('c1', ['student.view', 'student.directory', 'student.register']);
  return {
    k,
    A,
    B,
    teacherId: t.id,
    receptionId,
    c1OnlyId,
    owner: await ctxOf(A.ownerId, Role.STAFF, A.acad.id),
    ownerB: await ctxOf(B.ownerId, Role.STAFF, B.acad.id),
    reception: await ctxOf(receptionId, Role.STAFF, A.acad.id),
    reception2: await ctxOf(reception2Id, Role.STAFF, A.acad.id),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** A student in a group since yesterday (so expected at today's classes). */
async function member(w: World, groupId: string, name: string, academyId = w.A.acad.id) {
  const s = await makeStudent(academyId, name);
  await prisma.groupMembership.create({
    data: {
      groupId,
      studentId: s.studentId,
      academyId,
      addedAt: new Date(Date.now() - 86_400_000),
    },
  });
  return s;
}

/** A one-off class of `groupId` starting `offsetMin` from now. */
async function classAt(
  academyId: string,
  createdBy: string,
  groupId: string,
  offsetMin: number,
  durationMin = 90,
) {
  const startAt = new Date(Date.now() + offsetMin * MIN);
  return prisma.groupSession.create({
    data: {
      academyId,
      groupId,
      startAt,
      endAt: new Date(startAt.getTime() + durationMin * MIN),
      locationType: 'CENTER',
      createdBy,
    },
  });
}
const classOf = (w: World, groupId: string, offsetMin: number, durationMin = 90) =>
  classAt(w.A.acad.id, w.A.ownerId, groupId, offsetMin, durationMin);

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as { response?: { code?: string } })?.response?.code ?? (e as Error)?.message;
  }
  return 'NO_ERROR';
}
const recordsOf = (sessionId: string, studentId: string) =>
  prisma.attendanceRecord.findMany({
    where: { session: { groupSessionId: sessionId }, studentId },
  });

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — the card in the database', () => {
  it('only a digest is stored; the database refuses anything else', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'هدى');
    const issued = await desk.issue(w.reception, s.id);
    expect(issued.token).toMatch(/^\d{48}$/);
    const row = await prisma.academyStudentCard.findUniqueOrThrow({
      where: { id: issued.card.id },
    });
    expect(row.tokenHash).toBe(hashCardToken(issued.token));
    // No column of any card row holds the token.
    const [hit] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int n FROM "AcademyStudentCard" t WHERE t::text LIKE ${'%' + issued.token + '%'}`;
    expect(hit.n).toBe(0);
    // A raw token in tokenHash fails the CHECK.
    await expect(
      prisma.$executeRaw`INSERT INTO "AcademyStudentCard"(id,"academyId","academyStudentId","tokenHash","issuedBy")
        VALUES (${randomUUID()}, ${w.A.acad.id}, ${s.id}, ${generateCardToken()}, ${w.A.ownerId})`,
    ).rejects.toThrow(/AcademyStudentCard_hash_only/);
  });

  it('one active card per learner, a card never crosses academies or changes identity', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'منة');
    const { card } = await desk.issue(w.reception, s.id);
    const insert = (academyId: string) =>
      prisma.$executeRaw`INSERT INTO "AcademyStudentCard"(id,"academyId","academyStudentId","tokenHash","issuedBy")
        VALUES (${randomUUID()}, ${academyId}, ${s.id}, ${hashCardToken(generateCardToken())}, ${w.A.ownerId})`;
    await expect(insert(w.A.acad.id)).rejects.toThrow(/23505.*academyStudentId.*already exists/);
    await expect(insert(w.B.acad.id)).rejects.toThrow(/crosses academies/);
    await expect(
      prisma.$executeRaw`UPDATE "AcademyStudentCard" SET "tokenHash" = ${hashCardToken(generateCardToken())} WHERE id = ${card.id}`,
    ).rejects.toThrow(/cannot change identity/);
    await desk.revoke(w.reception, s.id, { cardId: card.id, reason: 'LOST' });
    await expect(
      prisma.$executeRaw`UPDATE "AcademyStudentCard" SET "revokedAt" = NULL, "revokedBy" = NULL, "revokeReason" = NULL WHERE id = ${card.id}`,
    ).rejects.toThrow(/revoked for good/);
    await expect(
      prisma.$executeRaw`UPDATE "AcademyStudentCard" SET "revokedBy" = NULL WHERE id = ${card.id}`,
    ).rejects.toThrow(/revoked for good|revocation_whole/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — card lifecycle', () => {
  it('issue → resolve; reissue → old fails at once, new works; revoke → fails', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'ياسين');
    const first = await desk.issue(w.reception, s.id);
    expect(first.print).toMatchObject({ fullName: 'ياسين', code: s.code });
    expect(Object.keys(first.print)).not.toEqual(
      expect.arrayContaining(['studentPhone', 'guardianPhone']),
    );
    expect((await desk.resolve(w.reception, { token: first.token })).student.id).toBe(s.id);

    const second = await desk.reissue(w.reception, s.id, { cardId: first.card.id, reason: 'LOST' });
    expect(await refusal(desk.resolve(w.reception, { token: first.token }))).toBe('CARD_REVOKED');
    expect((await desk.resolve(w.reception, { token: second.token })).via).toBe('QR');

    const r = await desk.revoke(w.reception, s.id, { cardId: second.card.id, reason: 'DAMAGED' });
    expect(r.changed).toBe(true);
    expect(r.active).toBeNull();
    expect(await refusal(desk.resolve(w.reception, { token: second.token }))).toBe('CARD_REVOKED');
    // Revoking again is harmless.
    expect(
      (await desk.revoke(w.reception, s.id, { cardId: second.card.id, reason: 'DAMAGED' })).changed,
    ).toBe(false);

    const history = await prisma.academyStudentCard.findMany({
      where: { academyStudentId: s.id },
      orderBy: { issuedAt: 'asc' },
    });
    expect(history.map((c) => c.revokeReason)).toEqual(['LOST', 'DAMAGED']);
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.A.acad.id, action: { startsWith: 'card.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual(['card.issue', 'card.reissue', 'card.revoke']);
    const text = JSON.stringify(log);
    for (const secret of [first.token, second.token, 'ياسين', s.code])
      expect(text).not.toContain(secret);
  });

  it('two issues at once: one card; two reissues at once: one wins, one CARD_CHANGED', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'رنا');
    const both = await Promise.allSettled([
      desk.issue(w.reception, s.id),
      desk.issue(w.reception2, s.id),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.response.code).toBe('CARD_ALREADY_ACTIVE');
    const active = (await desk.cardState(w.owner, s.id)).active!;

    const re = await Promise.allSettled([
      desk.reissue(w.reception, s.id, { cardId: active.id }),
      desk.reissue(w.reception2, s.id, { cardId: active.id }),
    ]);
    expect(re.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (re.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response.code,
    ).toBe('CARD_CHANGED');
    expect(
      await prisma.academyStudentCard.count({ where: { academyStudentId: s.id, revokedAt: null } }),
    ).toBe(1);
    const winner = (
      re.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ token: string }>
    ).value;
    expect((await desk.resolve(w.reception, { token: winner.token })).student.id).toBe(s.id);
  });

  it('reissue racing revoke: never two active cards, never an active card left behind wrongly', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'سلمى');
    const { card } = await desk.issue(w.reception, s.id);
    const out = await Promise.allSettled([
      desk.reissue(w.reception, s.id, { cardId: card.id }),
      desk.revoke(w.reception2, s.id, { cardId: card.id, reason: 'SECURITY' }),
    ]);
    const active = await prisma.academyStudentCard.findMany({
      where: { academyStudentId: s.id, revokedAt: null },
    });
    expect(active.length).toBeLessThanOrEqual(1);
    // Whichever went first, the original card is dead.
    expect(
      (await prisma.academyStudentCard.findUniqueOrThrow({ where: { id: card.id } })).revokedAt,
    ).not.toBeNull();
    if (out[0].status === 'fulfilled') expect(active).toHaveLength(1);
    else expect(out[0].reason.response.code).toBe('CARD_CHANGED');
  });

  it('a withdrawn learner gets no new card; cards of another academy are unknown', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await makeStudent(w.A.acad.id, 'نادر');
    await prisma.academyStudent.update({
      where: { id: s.id },
      data: { status: 'WITHDRAWN', leftAt: new Date() },
    });
    expect(await refusal(desk.issue(w.reception, s.id))).toBe('STUDENT_WITHDRAWN');
    const other = await makeStudent(w.B.acad.id, 'غريب');
    const foreign = await desk.issue(w.ownerB, other.id);
    // A's desk: another academy's card, a made-up card and garbage all look the same.
    expect(await refusal(desk.resolve(w.reception, { token: foreign.token }))).toBe(
      'CARD_NOT_FOUND',
    );
    expect(await refusal(desk.resolve(w.reception, { token: generateCardToken() }))).toBe(
      'CARD_NOT_FOUND',
    );
    expect(await refusal(desk.resolve(w.reception, { token: 'hello' }))).toBe('CARD_NOT_FOUND');
    // …and another academy's learner cannot be touched by id.
    expect(await refusal(desk.issue(w.reception, other.id))).toBe('STUDENT_NOT_FOUND');
    expect(await refusal(desk.cardState(w.reception, other.id))).toBe('STUDENT_NOT_FOUND');
    expect(await refusal(desk.resolve(w.reception, { academyStudentId: other.id }))).toBe(
      'STUDENT_NOT_FOUND',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — resolve and check in', () => {
  it('one class open: CHECK_IN; inside the grace PRESENT with method QR, and exactly once', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'أمل');
    const c = await classOf(w, w.A.gA.id, -3); // started 3 min ago, grace 10
    const { token } = await desk.issue(w.reception, s.id);
    const view = await desk.resolve(w.reception, { token });
    expect(view.action).toEqual({ kind: 'CHECK_IN', sessionId: c.id });
    expect(view.classes[0]).toMatchObject({ kind: 'HOME', state: 'OPEN', lateNow: false });
    // Same card, scanned twice at once by two desks, plus a retry.
    const shots = await Promise.all([
      desk.checkIn(w.reception, { token }),
      desk.checkIn(w.reception2, { token }),
    ]);
    const again = await desk.checkIn(w.reception, { token });
    expect(shots.map((x) => x.outcome).sort()).toEqual(['ALREADY', 'CHECKED_IN']);
    expect(again.outcome).toBe('ALREADY');
    const recs = await recordsOf(c.id, s.studentId);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      status: 'PRESENT',
      method: 'QR',
      markedBy: expect.any(String),
    });
    expect(recs[0].checkedInAt).not.toBeNull();
    const log = await prisma.auditLog.findMany({
      where: { academyId: w.A.acad.id, action: 'attendance.mark' },
    });
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(token);
  });

  it('after the grace a first check-in is LATE by the server clock; code → CODE, picked → MANUAL', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await member(w, w.A.gA.id, 'بسمة');
    const b = await member(w, w.A.gA.id, 'حازم');
    const c = await classOf(w, w.A.gA.id, -20); // 20 min in, grace 10
    const byCode = await desk.checkIn(w.reception, { code: a.code });
    const picked = await desk.checkIn(w.reception, { academyStudentId: b.id });
    expect(byCode.record).toMatchObject({ status: 'LATE', method: 'CODE', sessionId: c.id });
    expect(picked.record).toMatchObject({ status: 'LATE', method: 'MANUAL' });
    // Arabic-Indic digits typed at the desk read the same.
    const arabic = [...a.code].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');
    expect((await desk.resolve(w.reception, { code: arabic })).student.id).toBe(a.id);
  });

  it('two classes open: CHOOSE, and Rush mode refuses to guess', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'مريم');
    await prisma.groupMembership.create({
      data: {
        groupId: w.A.gB.id,
        studentId: s.studentId,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const c1 = await classOf(w, w.A.gA.id, -5);
    const c2 = await classOf(w, w.A.gB.id, 30);
    const view = await desk.resolve(w.reception, { code: s.code });
    expect(view.action.kind).toBe('CHOOSE');
    const auto = await desk.checkIn(w.reception, { code: s.code });
    expect(auto.outcome).toBe('NEEDS_DESK');
    expect(await recordsOf(c1.id, s.studentId)).toHaveLength(0);
    const chosen = await desk.checkIn(w.reception, { code: s.code, sessionId: c2.id });
    expect(chosen.record).toMatchObject({ status: 'PRESENT', sessionId: c2.id });
  });

  it('no class: NO_CLASS with the next one; too early, ended and closed are refused', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'عمر');
    // One group's classes may not overlap (C2), so these sit apart.
    const later = await classOf(w, w.A.gA.id, 120);
    const view = await desk.resolve(w.reception, { code: s.code });
    expect(view.action).toEqual({ kind: 'NO_CLASS', reason: 'NONE_OPEN', nextSessionId: later.id });
    expect(await refusal(desk.checkIn(w.reception, { code: s.code, sessionId: later.id }))).toBe(
      'ATTENDANCE_NOT_OPEN',
    );
    const ended = await classOf(w, w.A.gA.id, -200, 90);
    expect(await refusal(desk.checkIn(w.reception, { code: s.code, sessionId: ended.id }))).toBe(
      'CLASS_ENDED',
    );
    const closed = await classOf(w, w.A.gA.id, -100, 190);
    await classes.close(w.owner, closed.id);
    expect(await refusal(desk.checkIn(w.reception, { code: s.code, sessionId: closed.id }))).toBe(
      'ATTENDANCE_CLOSED',
    );
    // The close's automatic absence stays exactly as it was.
    const [rec] = await recordsOf(closed.id, s.studentId);
    expect(rec).toMatchObject({ status: 'ABSENT', method: 'AUTO' });
  });

  it('a mark the teacher already made is reported, never overwritten by the desk', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'فرح');
    const c = await classOf(w, w.A.gA.id, -5);
    await classes.mark(w.owner, c.id, { records: [{ studentId: s.studentId, status: 'EXCUSED' }] });
    const r = await desk.checkIn(w.reception, { code: s.code });
    expect(r.outcome).toBe('ALREADY');
    const [rec] = await recordsOf(c.id, s.studentId);
    expect(rec).toMatchObject({ status: 'EXCUSED', method: 'MANUAL' });
  });

  it('withdrawn: identified, shown as withdrawn, never checked in', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'طارق');
    const c = await classOf(w, w.A.gA.id, -5);
    const { token } = await desk.issue(w.reception, s.id);
    await prisma.academyStudent.update({
      where: { id: s.id },
      data: { status: 'WITHDRAWN', leftAt: new Date(Date.now() - 3_600_000) },
    });
    const view = await desk.resolve(w.reception, { token });
    expect(view.action.kind).toBe('WITHDRAWN');
    expect(view.makeupOptions).toHaveLength(0);
    expect(await refusal(desk.checkIn(w.reception, { token, sessionId: c.id }))).toBe(
      'STUDENT_WITHDRAWN',
    );
    expect(await recordsOf(c.id, s.studentId)).toHaveLength(0);
  });

  it('makeup: only when confirmed; no membership; home stays; seats counted; last seat raced', async () => {
    if (!guard()) return;
    const w = await world();
    await prisma.group.update({ where: { id: w.A.gB.id }, data: { capacity: 3 } });
    await member(w, w.A.gB.id, 'ب١');
    await member(w, w.A.gB.id, 'ب٢'); // 2 of 3 seats taken
    const x = await member(w, w.A.gA.id, 'زائر١');
    const y = await member(w, w.A.gA.id, 'زائر٢');
    const target = await classOf(w, w.A.gB.id, -2);
    const view = await desk.resolve(w.reception, { code: x.code });
    expect(view.makeupOptions.map((m) => m.sessionId)).toEqual([target.id]);
    expect(view.makeupOptions[0]).toMatchObject({ capacity: 3, seated: 2, full: false });
    expect(await refusal(desk.checkIn(w.reception, { code: x.code, sessionId: target.id }))).toBe(
      'MAKEUP_REQUIRED',
    );
    const race = await Promise.allSettled([
      desk.checkIn(w.reception, { code: x.code, sessionId: target.id, makeup: true }),
      desk.checkIn(w.reception2, { code: y.code, sessionId: target.id, makeup: true }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.response.code,
    ).toBe('GROUP_FULL');
    const guests = await prisma.attendanceRecord.findMany({
      where: { session: { groupSessionId: target.id }, homeGroupId: { not: null } },
    });
    expect(guests).toHaveLength(1);
    expect(guests[0]).toMatchObject({ homeGroupId: w.A.gA.id, method: 'CODE' });
    // Never a membership in B; home in A stays open.
    for (const s of [x, y]) {
      expect(
        await prisma.groupMembership.count({
          where: { groupId: w.A.gB.id, studentId: s.studentId },
        }),
      ).toBe(0);
      expect(
        await prisma.groupMembership.count({
          where: { groupId: w.A.gA.id, studentId: s.studentId, deletedAt: null },
        }),
      ).toBe(1);
    }
  });

  it('revoke vs scan: a check-in waiting on a card being revoked is refused once the revoke commits', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'كارت');
    const c = await classOf(w, w.A.gA.id, -1);
    const { token, card } = await desk.issue(w.reception, s.id);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // A revoke that holds the card's row lock until released.
    const revoking = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "AcademyStudentCard"
          SET "revokedAt" = now(), "revokedBy" = ${w.A.ownerId}, "revokeReason" = 'SECURITY'
          WHERE id = ${card.id}`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    // Identify reads the card before the revoke commits (it still looks active)…
    const scan = desk.checkIn(w.reception, { token, sessionId: c.id });
    await new Promise((r) => setTimeout(r, 600));
    release();
    await revoking;
    // …but writing the record waits on the card's lock and then sees it revoked.
    expect(await refusal(scan)).toBe('CARD_REVOKED');
    expect(await recordsOf(c.id, s.studentId)).toHaveLength(0);
  });

  it('close vs scan: they queue on the class row; the result is one of the two consistent outcomes', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'سباق');
    const c = await classOf(w, w.A.gA.id, -5);
    const [scan] = await Promise.allSettled([
      desk.checkIn(w.reception, { code: s.code, sessionId: c.id }),
      classes.close(w.owner, c.id),
    ]);
    const recs = await recordsOf(c.id, s.studentId);
    expect(recs).toHaveLength(1);
    if (scan.status === 'fulfilled') expect(recs[0].status).toBe('PRESENT');
    else {
      expect(scan.reason.response.code).toBe('ATTENDANCE_CLOSED');
      expect(recs[0]).toMatchObject({ status: 'ABSENT', method: 'AUTO' });
    }
  });

  it('QR and code for the same learner at the same moment: one record', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'توأم');
    const c = await classOf(w, w.A.gA.id, -1);
    const { token } = await desk.issue(w.reception, s.id);
    await Promise.all([
      desk.checkIn(w.reception, { token }),
      desk.checkIn(w.reception2, { code: s.code }),
      desk.checkIn(w.reception, { academyStudentId: s.id }),
    ]);
    expect(await recordsOf(c.id, s.studentId)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — the token never reaches a log', () => {
  it('issue, resolve, check-in, a revoked scan and an unknown scan log nothing of the token', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'سجل');
    await classOf(w, w.A.gA.id, -1);
    const lines: string[] = [];
    const grab = (...a: unknown[]) => void lines.push(a.map((x) => String(x)).join(' '));
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(grab),
      ),
      ...(['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation(grab),
      ),
    ];
    try {
      const { token, card } = await desk.issue(w.reception, s.id);
      await desk.resolve(w.reception, { token });
      await desk.checkIn(w.reception, { token });
      await desk.revoke(w.reception, s.id, { cardId: card.id, reason: 'LOST' });
      await refusal(desk.resolve(w.reception, { token }));
      const unknown = generateCardToken();
      await refusal(desk.resolve(w.reception, { token: unknown }));
      const all = lines.join(' | ');
      expect(all).not.toContain(token);
      expect(all).not.toContain(unknown);
    } finally {
      spies.forEach((sp) => sp.mockRestore());
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — who may do what', () => {
  async function viaGuards(user: JwtPayload, academyId: string, method: keyof DeskController) {
    const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
    const exec: any = {
      getHandler: () => DeskController.prototype[method],
      getClass: () => DeskController,
      switchToHttp: () => ({ getRequest: () => req }),
    };
    await new AcademyMembershipGuard(academy).canActivate(exec);
    new PermissionGuard(new Reflector()).canActivate(exec);
    await new FeatureFlagGuard(new Reflector(), flags).canActivate(exec);
    return req.academyContext as AcademyContext;
  }
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'ALLOWED',
      (e) =>
        e instanceof ForbiddenException
          ? 'FORBIDDEN'
          : e instanceof NotFoundException
            ? 'NOT_FOUND'
            : `OTHER:${e?.message}`,
    );
  const ROUTES = ['resolve', 'checkIn', 'card', 'issue', 'reissue', 'revoke'] as const;

  it('reception with the desk: every desk route; owner: every route', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of ROUTES) {
      expect(await outcome(viaGuards(jwt(w.receptionId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'ALLOWED',
      );
    }
  });

  it('teacher, C1-only reception, a student and another academy are refused', async () => {
    if (!guard()) return;
    const w = await world();
    const student = await prisma.user.create({ data: { role: 'STUDENT', fullName: 'x' } });
    for (const m of ROUTES) {
      expect(await outcome(viaGuards(jwt(w.teacherId, Role.TEACHER), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(w.c1OnlyId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
      expect(await outcome(viaGuards(jwt(student.id, Role.STUDENT), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
      // B's owner naming A: no membership there.
      expect(await outcome(viaGuards(jwt(w.B.ownerId, Role.STAFF), w.A.acad.id, m))).not.toBe(
        'ALLOWED',
      );
    }
  });

  it('the desk stays shut until receptionDesk is on — classOperations alone opens nothing', async () => {
    if (!guard()) return;
    const w = await world();
    await flags.setFlag(w.A.acad.id, 'receptionDesk', false, w.A.ownerId);
    for (const m of ROUTES)
      expect(await outcome(viaGuards(jwt(w.A.ownerId, Role.STAFF), w.A.acad.id, m))).toBe(
        'FORBIDDEN',
      );
    const a = await new DeskController(desk, flags).access(w.owner);
    expect(a).toMatchObject({ enabled: false, canCheckIn: false, canManageCards: false });
    await flags.setFlag(w.A.acad.id, 'receptionDesk', true, w.A.ownerId);
    // Desk on, classes off: identify works, check-in says so.
    await flags.setFlag(w.A.acad.id, 'classOperations', false, w.A.ownerId);
    const s = await makeStudent(w.A.acad.id, 'مغلق');
    expect((await desk.resolve(w.reception, { code: s.code })).action).toEqual({
      kind: 'NO_CLASS',
      reason: 'CLASSES_OFF',
    });
    expect(await refusal(desk.checkIn(w.reception, { code: s.code }))).toBe('CLASSES_OFF');
  });

  it('mass assignment: server-owned fields are refused before any code runs', async () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const meta = { type: 'body' as const, metatype: DeskCheckInDto };
    for (const extra of [
      { academyId: 'x' },
      { method: 'QR' },
      { status: 'PRESENT' },
      { checkedInAt: new Date().toISOString() },
      { tokenHash: 'a'.repeat(64) },
      { markedBy: 'x' },
      { studentId: 'x' },
    ])
      await expect(pipe.transform({ code: '123456', ...extra }, meta)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    expect(await refusal(desk.resolve({} as AcademyContext, {}))).toBe('DESK_IDENTITY_REQUIRED');
  });

  it('probing is paused after repeated misses; real scans never count', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await member(w, w.A.gA.id, 'حقيقي');
    await classOf(w, w.A.gA.id, -1);
    // A long honest queue: no misses, no pause.
    for (let i = 0; i < MISS_LIMIT + 5; i++) await desk.resolve(w.reception, { code: s.code });
    for (let i = 0; i < MISS_LIMIT; i++)
      expect(await refusal(desk.resolve(w.reception, { token: generateCardToken() }))).toBe(
        'CARD_NOT_FOUND',
      );
    expect(await refusal(desk.resolve(w.reception, { token: generateCardToken() }))).toBe(
      'DESK_TOO_MANY_MISSES',
    );
    expect(await refusal(desk.resolve(w.reception, { code: s.code }))).toBe('DESK_TOO_MANY_MISSES');
    // Another receptionist is unaffected.
    expect((await desk.resolve(w.reception2, { code: s.code })).student.id).toBe(s.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('C3 — scale', () => {
  it('10,000 learners with cards, 100 classes today: a scan resolves and checks in quickly', async () => {
    if (!guard()) return;
    const w = await world();
    const N = 10_000;
    const gs = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        prisma.group.create({ data: { academyId: w.A.acad.id, name: `S${i}` } }),
      ),
    );
    const users = await prisma.user.createManyAndReturn({
      data: Array.from({ length: N }, (_, i) => ({ role: 'STUDENT' as const, fullName: `s${i}` })),
      select: { id: true },
    });
    const profiles = await prisma.studentProfile.createManyAndReturn({
      data: users.map((u) => ({ userId: u.id })),
      select: { id: true },
    });
    const codes = new Set<string>();
    while (codes.size < N) codes.add(generateStudentCode());
    const code = [...codes];
    const recs = await prisma.academyStudent.createManyAndReturn({
      data: profiles.map((p, i) => ({
        academyId: w.A.acad.id,
        studentId: p.id,
        code: code[i],
        fullName: `طالب ${i}`,
        source: 'IMPORT' as const,
      })),
      select: { id: true, studentId: true, code: true },
    });
    const tokens = recs.map(() => generateCardToken());
    await prisma.academyStudentCard.createMany({
      data: recs.map((r, i) => ({
        academyId: w.A.acad.id,
        academyStudentId: r.id,
        tokenHash: hashCardToken(tokens[i]),
        issuedBy: w.A.ownerId,
      })),
    });
    await prisma.groupMembership.createMany({
      data: recs.map((r, i) => ({
        groupId: gs[i % 100].id,
        studentId: r.studentId,
        academyId: w.A.acad.id,
        addedAt: new Date(Date.now() - 86_400_000),
      })),
    });
    // Every group has a class on now and one later today.
    for (const g of gs) {
      await classOf(w, g.id, -5, 60);
      await classOf(w, g.id, 120, 60);
    }
    const time = async (f: () => Promise<unknown>) => {
      const t = process.hrtime.bigint();
      await f();
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    await desk.resolve(w.reception, { token: tokens[0] }); // warm
    const byToken: number[] = [];
    const byCode: number[] = [];
    const checkIn: number[] = [];
    for (let i = 1; i <= 20; i++) {
      byToken.push(await time(() => desk.resolve(w.reception, { token: tokens[i * 37] })));
      byCode.push(await time(() => desk.resolve(w.reception, { code: code[i * 41] })));
      checkIn.push(await time(() => desk.checkIn(w.reception, { token: tokens[i * 53] })));
    }
    const [plan] = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': any }[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM "AcademyStudentCard" WHERE "tokenHash" = '${hashCardToken(tokens[5])}'`,
    );
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(
      `C3 scale (${N} learners, ${N} cards, 200 classes today): resolve by token median ${med(byToken).toFixed(1)} ms, ` +
        `by code ${med(byCode).toFixed(1)} ms, auto check-in ${med(checkIn).toFixed(1)} ms; ` +
        `token lookup in the DB ${plan['QUERY PLAN'][0]['Execution Time']} ms (${plan['QUERY PLAN'][0].Plan['Node Type']})`,
    );
    expect(plan['QUERY PLAN'][0].Plan['Node Type']).toMatch(/Index/);
    expect(med(byToken)).toBeLessThan(500);
    expect(med(checkIn)).toBeLessThan(800);
    const done = await prisma.attendanceRecord.count({
      where: { academyId: w.A.acad.id, method: 'QR' },
    });
    expect(done).toBe(20);
  }, 300_000);
});

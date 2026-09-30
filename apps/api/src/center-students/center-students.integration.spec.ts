import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { StaffScopeService } from '../academy/staff-scope.service';
import { GroupsService } from '../academy-ops/groups.service';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { AdminService } from '../admin/admin.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { ConversationPolicy } from '../chat/conversation-policy';
import { databaseReady } from '../common/testing/db-available';
import { FeatureFlagGuard } from '../feature-flags/guards/feature-flag.guard';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffService } from '../staff/staff.service';
import { CenterStudentsController } from './center-students.controller';
import { CenterStudentsService } from './center-students.service';
import * as codes from './student-code';
import { isValidStudentCode } from './student-code';
import { StudentImportService } from './student-import.service';

/**
 * Center Operations C1 — the student register, against a real PostgreSQL
 * (its triggers, CHECKs, unique indexes and advisory locks are part of what
 * is under test) and the routes' real guards.
 *
 * The world: Center A with an owner, a teacher (who wrote a course and has
 * one online student, Omar), a receptionist (an assistant granted the
 * Reception preset) and two groups; Center B with its own owner, group and
 * student. The register is switched on for both.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const scopes = new StaffScopeService(prisma, academy);
const audit = new AuditService(prisma);
const flags = new FeatureFlagsService(prisma);
const realtime = { leaveThread: jest.fn(), emitToUser: () => undefined } as any;
const groups = new GroupsService(prisma, new AcademyOpsAccessService(prisma), audit, realtime);
const students = new CenterStudentsService(prisma, audit, groups);
const imports = new StudentImportService(prisma, audit);
const staff = new StaffService(prisma, scopes, new ConversationPolicy(prisma, scopes));
const mail = { sendInBackground: jest.fn(), webUrl: (p: string) => p };
const auth = new AuthService(prisma, {} as any, mail as any, {} as any);

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, ['academyStudent', 'studentImport', 'groupMembership']);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role, tenantId?: string) =>
  ({ sub, role, tenantId, sessionId: 's' }) as JwtPayload;

let seq = 0;
/** A fresh request key per logical action, as the web client makes one. */
const key = () => `k${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 6)}`;

async function makeCenter(k: string, tag: string) {
  const owner = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Owner ${tag} ${k}`, email: `c1-${tag}-o-${k}@it.test` },
  });
  const acad = await prisma.academy.create({
    data: {
      slug: `c1-${tag}-${k}`,
      name: `Center ${tag} ${k}`,
      ownerUserId: owner.id,
      kind: 'CENTER',
    },
  });
  await prisma.academyMembership.create({
    data: { userId: owner.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  await flags.setFlag(acad.id, 'studentRegistry', true, owner.id);
  const g1 = await prisma.group.create({ data: { academyId: acad.id, name: `Group A ${tag}` } });
  const g2 = await prisma.group.create({ data: { academyId: acad.id, name: `Group B ${tag}` } });
  return { acad, owner: { userId: owner.id, jwt: jwt(owner.id, Role.STAFF) }, g1, g2 };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const A = await makeCenter(k, 'a');
  const B = await makeCenter(k, 'b');

  // A teacher of Center A, with a course and one online student (Omar).
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `c1-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `c1-t-${k}`, status: 'APPROVED' },
  });
  await prisma.academyMembership.create({
    data: { userId: tUser.id, academyId: A.acad.id, role: 'TEACHER', status: 'ACTIVE' },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: A.acad.id, title: `Physics ${k}`, status: 'PUBLISHED' },
  });
  const omarUser = await prisma.user.create({
    data: {
      role: 'STUDENT',
      fullName: `عمر خالد ${k}`,
      email: `c1-omar-${k}@it.test`,
      passwordHash: 'x',
    },
  });
  const omar = await prisma.studentProfile.create({ data: { userId: omarUser.id } });
  await prisma.enrollment.create({
    data: {
      studentId: omar.id,
      courseId: course.id,
      tenantId: tp.id,
      academyId: A.acad.id,
      status: 'ACTIVE',
    },
  });

  // Reception: an assistant with the Reception preset (all courses).
  const rUser = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Reception ${k}`, email: `c1-r-${k}@it.test` },
  });
  await prisma.academyMembership.create({
    data: {
      userId: rUser.id,
      academyId: A.acad.id,
      role: 'ASSISTANT',
      status: 'ACTIVE',
      courseScope: 'ALL',
      permissions: ['student.view', 'student.directory', 'student.register'],
    },
  });

  return {
    k,
    A,
    B,
    course,
    omar: { studentId: omar.id, userId: omarUser.id },
    teacher: { userId: tUser.id, jwt: jwt(tUser.id, Role.TEACHER, tp.id) },
    reception: { userId: rUser.id, jwt: jwt(rUser.id, Role.STAFF) },
  };
}

const ctxOf = async (user: JwtPayload, academyId: string): Promise<AcademyContext> =>
  (await academy.buildContext(user.sub, academyId, user.role))!;

/** Run a register route's real guards (membership, capability, flag) for this caller and header. */
async function viaGuards(
  user: JwtPayload,
  academyId: string,
  method: keyof CenterStudentsController,
) {
  const req: any = { user, headers: { 'x-academy-id': academyId }, params: {} };
  const exec: any = {
    getHandler: () => CenterStudentsController.prototype[method],
    getClass: () => CenterStudentsController,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  await new AcademyMembershipGuard(academy).canActivate(exec);
  new PermissionGuard(new Reflector()).canActivate(exec);
  await new FeatureFlagGuard(new Reflector(), flags).canActivate(exec);
  return req.academyContext as AcademyContext;
}

const register = (ctx: AcademyContext, over: Record<string, unknown> = {}) =>
  students.register(ctx, { requestKey: key(), fullName: 'أحمد محمد علي', ...over } as any);

describe('C1 — shell students cannot sign in', () => {
  it('a desk registration creates a learner with no email, phone, username or password', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx, {
      studentPhone: '01012345678',
      guardianPhone: '01112345678',
    });
    const profile = await prisma.studentProfile.findUniqueOrThrow({
      where: { id: student.studentId },
      include: { user: true },
    });
    expect(profile.user).toMatchObject({
      role: 'STUDENT',
      email: null,
      phone: null,
      username: null,
      passwordHash: null,
    });
    expect(profile.provisionedByAcademyId).toBe(w.A.acad.id);
    expect(student.hasAccount).toBe(false);
    // The phones the desk typed are contact details on the register, never login handles.
    expect(student.studentPhone).toBe('+201012345678');
    expect(mail.sendInBackground).not.toHaveBeenCalled();
  });

  it('no identifier reaches a shell: not its name, its code, or the phones on its record', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx, {
      fullName: `shell${w.k}`,
      studentPhone: '01099988877',
      guardianPhone: '01199988877',
    });
    for (const identifier of [`shell${w.k}`, student.code, '01099988877', '01199988877']) {
      await expect(
        auth.login({ identifier, password: 'anything1' } as any, {} as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // A reset is keyed by email; a shell has none, so nothing is ever issued for it.
    await auth.forgotPassword({ email: `shell${w.k}@nowhere.test` } as any);
    const u = await prisma.studentProfile.findUniqueOrThrow({
      where: { id: student.studentId },
      select: { userId: true },
    });
    expect(await prisma.passwordResetToken.count({ where: { userId: u.userId } })).toBe(0);
    expect(await prisma.deviceSession.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('a real student can still sign up with the phone a center stored on a record', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const phone = `010${String(Date.now()).slice(-8)}`;
    await register(ctx, { guardianPhone: phone });
    // Account phones are unique among accounts only; the register's are not accounts.
    expect(await prisma.user.count({ where: { phone: `+20${phone.slice(1)}` } })).toBe(0);
  });
});

describe('C1 — codes', () => {
  it('is six digits with a valid check digit, unique per academy, and meaningless elsewhere', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const b = await ctxOf(w.B.owner.jwt, w.B.acad.id);
    const { student } = await register(a);
    expect(student.code).toMatch(/^[1-9][0-9]{5}$/);
    expect(isValidStudentCode(student.code)).toBe(true);
    // The same code can exist in another academy: codes are academy-scoped.
    const other = await register(b, { fullName: 'طالب آخر' });
    await prisma.academyStudent.update({
      where: { id: other.student.id },
      data: { code: student.code },
    });
    const inB = await students.list(b, { q: student.code });
    expect(inB.items.map((i) => i.id)).toEqual([other.student.id]);
    // The database refuses a code with a bad check digit, whoever writes it.
    const bad = student.code.slice(0, 5) + String((Number(student.code[5]) + 1) % 10);
    await expect(
      prisma.academyStudent.update({ where: { id: student.id }, data: { code: bad } }),
    ).rejects.toThrow();
  });

  it('a code collision is retried with a fresh code, not surfaced', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const first = await register(ctx, { fullName: 'الأول' });
    const spy = jest.spyOn(codes, 'generateStudentCode').mockReturnValueOnce(first.student.code);
    const second = await register(ctx, { fullName: 'الثاني' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(second.created).toBe(true);
    expect(second.student.code).not.toBe(first.student.code);
    spy.mockRestore();
    // The failed attempt left nothing behind: one shell per registration.
    expect(
      await prisma.user.count({
        where: { studentProfile: { provisionedByAcademyId: w.A.acad.id } },
      }),
    ).toBe(2);
  });
});

describe('C1 — search', () => {
  it('finds by code (Latin or Arabic digits), name, learner phone, guardian phone, fragments', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx, {
      fullName: 'أَحْمَد  مُحَمَّد عبد الله',
      studentPhone: '01023456789',
      guardianPhone: '01523456789',
    });
    const arabicDigits = student.code.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
    for (const q of [
      student.code,
      arabicDigits,
      'احمد محمد',
      'محمد احمد', // word order does not matter
      'عبدالله',
      '01023456789',
      '+20 102 345 6789',
      '٠١٥٢٣٤٥٦٧٨٩',
      '3456789',
    ]) {
      const { items } = await students.list(ctx, { q });
      expect({ q, ids: items.map((i) => i.id) }).toEqual({ q, ids: [student.id] });
    }
    const none = await students.list(ctx, { q: 'زياد' });
    expect(none.total).toBe(0);
  });

  it("never returns another academy's students, by any path", async () => {
    if (!guard()) return;
    const w = await world();
    const b = await ctxOf(w.B.owner.jwt, w.B.acad.id);
    const inB = await register(b, { fullName: 'سارة سري', guardianPhone: '01277776666' });
    const a = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    for (const q of [inB.student.code, 'سارة', '01277776666', '77776666']) {
      const { items, total } = await students.list(a, { q, status: 'ALL' });
      expect(items.map((i) => i.id)).not.toContain(inB.student.id);
      // Not even a count: a total of 1 with no rows would confirm B's student exists.
      expect({ q, total }).toEqual({ q, total: 0 });
    }
    const all = await students.list(a, { status: 'ALL' });
    expect(all.total).toBe(all.items.length); // A's whole register is Omar alone
    await expect(students.get(a, inB.student.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await students.forStudent(a, inB.student.studentId)).toBeNull();
  });

  it('pages, and filters by status', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    for (let i = 0; i < 7; i++) await register(ctx, { fullName: `طالب رقم ${i}` });
    const p1 = await students.list(ctx, { q: 'طالب رقم', pageSize: 5 });
    const p2 = await students.list(ctx, { q: 'طالب رقم', pageSize: 5, page: 2 });
    expect(p1.total).toBe(7);
    expect(p1.items).toHaveLength(5);
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(7);
    await students.withdraw(ctx, p1.items[0].id);
    expect((await students.list(ctx, { q: 'طالب رقم' })).total).toBe(6);
    expect(
      (await students.list(ctx, { q: 'طالب رقم', status: 'WITHDRAWN' })).items.map((i) => i.id),
    ).toEqual([p1.items[0].id]);
    expect((await students.list(ctx, { q: 'طالب رقم', status: 'ALL' })).total).toBe(7);
  });
});

describe('C1 — duplicates', () => {
  it('warns on the same name with the same guardian phone; an override is allowed and audited', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const first = await register(ctx, { guardianPhone: '01011112222' });
    const warned = await register(ctx, {
      fullName: 'احمد محمد علي',
      guardianPhone: '010 1111 2222',
    }).catch((e) => e);
    expect(warned.getStatus()).toBe(409);
    expect(warned.getResponse()).toMatchObject({
      code: 'STUDENT_POSSIBLE_DUPLICATE',
      candidates: [{ id: first.student.id, code: first.student.code }],
    });
    const forced = await register(ctx, { guardianPhone: '01011112222', confirmDuplicate: true });
    expect(forced.created).toBe(true);
    const log = await prisma.auditLog.findFirst({
      where: { action: 'student.duplicate.override', entityId: forced.student.id },
    });
    expect(log?.meta).toMatchObject({ candidates: [first.student.id] });
  });

  it('siblings sharing a guardian phone are two students, no warning', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const ahmed = await register(ctx, { guardianPhone: '01033334444' });
    const youssef = await register(ctx, {
      fullName: 'يوسف محمد علي',
      guardianPhone: '01033334444',
    });
    expect(youssef.created).toBe(true);
    expect(youssef.student.studentId).not.toBe(ahmed.student.studentId);
    const { items } = await students.list(ctx, { q: '01033334444' });
    expect(items).toHaveLength(2);
  });

  it('two desks registering the same child at once: one record, the other warned', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        register(ctx, { fullName: 'مريم حسن', guardianPhone: '01055556666' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused.every((r) => r.reason.getResponse().code === 'STUDENT_POSSIBLE_DUPLICATE')).toBe(
      true,
    );
    expect((await students.list(ctx, { q: 'مريم حسن' })).total).toBe(1);
  });
});

describe('C1 — idempotent registration', () => {
  it('the same request repeated returns the first learner, sequentially and concurrently', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const requestKey = key();
    const body = { requestKey, fullName: 'ليلى سمير', groupId: w.A.g1.id };
    const all = await Promise.all(
      Array.from({ length: 6 }, () => students.register(ctx, body as any)),
    );
    const again = await students.register(ctx, body as any);
    const ids = new Set([...all, again].map((r) => r.student.id));
    expect(ids.size).toBe(1);
    expect([...all, again].filter((r) => r.created)).toHaveLength(1);
    const [id] = [...ids];
    const rec = await prisma.academyStudent.findUniqueOrThrow({ where: { id } });
    expect(
      await prisma.user.count({
        where: { fullName: 'ليلى سمير', studentProfile: { provisionedByAcademyId: w.A.acad.id } },
      }),
    ).toBe(1);
    expect(
      await prisma.groupMembership.count({
        where: { groupId: w.A.g1.id, studentId: rec.studentId },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'student.register', entityId: id } }),
    ).toBe(1);
  });

  it('a failure after the user row leaves nothing behind (one transaction)', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const spy = jest.spyOn(groups, 'writeMemberships').mockRejectedValueOnce(new Error('boom'));
    await expect(register(ctx, { fullName: 'فشل متعمد', groupId: w.A.g1.id })).rejects.toThrow(
      'boom',
    );
    spy.mockRestore();
    expect(await prisma.user.count({ where: { fullName: 'فشل متعمد' } })).toBe(0);
    expect(await prisma.academyStudent.count({ where: { fullName: 'فشل متعمد' } })).toBe(0);
  });

  it('validates what it stores: phones, the year, the group — all inside this academy', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    await expect(register(ctx, { studentPhone: '12345' })).rejects.toMatchObject({
      response: { code: 'INVALID_PHONE', field: 'studentPhone' },
    });
    await expect(register(ctx, { gradeId: 'nope' })).rejects.toMatchObject({
      response: { code: 'GRADE_NOT_FOUND' },
    });
    await expect(register(ctx, { groupId: w.B.g1.id })).rejects.toMatchObject({
      response: { code: 'GROUP_NOT_FOUND' },
    });
    await expect(register(ctx, { fullName: '   ' })).rejects.toMatchObject({
      response: { code: 'NAME_REQUIRED' },
    });
    expect(await prisma.academyStudent.count({ where: { academyId: w.A.acad.id } })).toBe(1); // Omar only
  });
});

describe('C1 — groups', () => {
  it('a desk student with no course joins a group; a double click adds once', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx);
    expect(await prisma.enrollment.count({ where: { studentId: student.studentId } })).toBe(0);
    const results = await Promise.all([
      students.addToGroup(ctx, student.id, { groupId: w.A.g2.id }),
      students.addToGroup(ctx, student.id, { groupId: w.A.g2.id }),
      students.addToGroup(ctx, student.id, { groupId: w.A.g2.id }),
    ]);
    expect(results.filter((r) => r.added)).toHaveLength(1);
    expect(
      await prisma.groupMembership.count({
        where: { groupId: w.A.g2.id, studentId: student.studentId },
      }),
    ).toBe(1);
    expect(results[2].student.groups.map((g) => g.id)).toEqual([w.A.g2.id]);
  });

  it("refuses another academy's group, and a withdrawn student", async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx);
    await expect(
      students.addToGroup(ctx, student.id, { groupId: w.B.g1.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await students.withdraw(ctx, student.id);
    await expect(
      students.addToGroup(ctx, student.id, { groupId: w.A.g1.id }),
    ).rejects.toMatchObject({
      response: { code: 'STUDENT_WITHDRAWN' },
    });
  });

  it('the group page (group.manage) admits register students, online students, and nobody else', async () => {
    if (!guard()) return;
    const w = await world();
    const owner = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const { student } = await register(owner);
    await groups.addMembers(owner, w.A.g1.id, {
      studentIds: [student.studentId, w.omar.studentId],
    });
    expect(
      await prisma.groupMembership.count({ where: { groupId: w.A.g1.id, deletedAt: null } }),
    ).toBe(2);
    const b = await ctxOf(w.B.owner.jwt, w.B.acad.id);
    const foreign = await register(b, { fullName: 'غريب' });
    await expect(
      groups.addMembers(owner, w.A.g1.id, { studentIds: [foreign.student.studentId] }),
    ).rejects.toMatchObject({ response: { code: 'STUDENTS_NOT_ENROLLED' } });
  });
});

describe('C1 — withdraw / reactivate', () => {
  it('withdrawing ends group places and keeps everything else; reactivating restores the record', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const omarRec = (await students.forStudent(ctx, w.omar.studentId))!;
    await groups.addMembers(ctx, w.A.g1.id, { studentIds: [w.omar.studentId] });
    const out = await students.withdraw(ctx, omarRec.id);
    expect(out.changed).toBe(true);
    expect(out.student).toMatchObject({ status: 'WITHDRAWN', groups: [] });
    expect(out.student.leftAt).not.toBeNull();
    // Online access, history and identity are untouched.
    expect(
      await prisma.enrollment.findFirst({ where: { studentId: w.omar.studentId } }),
    ).toMatchObject({
      status: 'ACTIVE',
    });
    expect(
      await prisma.groupMembership.count({
        where: { studentId: w.omar.studentId, deletedAt: { not: null } },
      }),
    ).toBe(1);
    expect(await students.get(ctx, omarRec.id)).toMatchObject({ code: omarRec.code });

    const back = await students.reactivate(ctx, omarRec.id);
    expect(back.student).toMatchObject({ status: 'ACTIVE', leftAt: null, code: omarRec.code });
  });

  it('a double click converges: one transition, one audit row', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx);
    const outs = await Promise.all([1, 2, 3].map(() => students.withdraw(ctx, student.id)));
    expect(outs.filter((o) => o.changed)).toHaveLength(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'student.withdraw', entityId: student.id } }),
    ).toBe(1);
    const ins = await Promise.all([1, 2, 3].map(() => students.reactivate(ctx, student.id)));
    expect(ins.filter((o) => o.changed)).toHaveLength(1);
  });

  it('withdraw racing reactivate and a group add never leaves an inconsistent record', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx);
    await Promise.allSettled([
      students.withdraw(ctx, student.id),
      students.reactivate(ctx, student.id),
      students.addToGroup(ctx, student.id, { groupId: w.A.g1.id }),
      students.withdraw(ctx, student.id),
    ]);
    const rec = await prisma.academyStudent.findUniqueOrThrow({ where: { id: student.id } });
    // The CHECK guarantees leftAt agrees with status; a withdrawn learner holds no group place.
    expect(rec.status === 'WITHDRAWN').toBe(rec.leftAt !== null);
    const places = await prisma.groupMembership.count({
      where: { studentId: student.studentId, deletedAt: null },
    });
    if (rec.status === 'WITHDRAWN') expect(places).toBe(0);
  });
});

describe('C1 — editing', () => {
  it("edits the register; keeps a desk learner's profile in step, never an online learner's", async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const grade = await prisma.gradeLevel.findFirst({ where: { isActive: true } });
    const { student } = await register(ctx);
    const edited = await students.update(ctx, student.id, {
      fullName: 'أحمد محمد علي حسن',
      guardianPhone: '01144445555',
      school: 'مدرسة النصر',
      ...(grade ? { gradeId: grade.id } : {}),
    });
    expect(edited).toMatchObject({ fullName: 'أحمد محمد علي حسن', guardianPhone: '+201144445555' });
    const shellUser = await prisma.studentProfile.findUniqueOrThrow({
      where: { id: student.studentId },
      select: { gradeId: true, user: { select: { fullName: true } } },
    });
    expect(shellUser.user.fullName).toBe('أحمد محمد علي حسن');
    if (grade) expect(shellUser.gradeId).toBe(grade.id);

    const omarRec = (await students.forStudent(ctx, w.omar.studentId))!;
    await students.update(ctx, omarRec.id, { fullName: 'عمر (اسم المركز)' });
    const omarUser = await prisma.user.findUniqueOrThrow({ where: { id: w.omar.userId } });
    expect(omarUser.fullName).toBe(`عمر خالد ${w.k}`);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'student.update', entityId: student.id },
    });
    expect(JSON.stringify(log?.meta)).not.toContain('1144445555'); // which fields, never their values
  });

  it("cannot touch another academy's record", async () => {
    if (!guard()) return;
    const w = await world();
    const b = await ctxOf(w.B.owner.jwt, w.B.acad.id);
    const inB = await register(b, { fullName: 'في المركز ب' });
    const a = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    await expect(students.update(a, inB.student.id, { fullName: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(students.withdraw(a, inB.student.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(students.reactivate(a, inB.student.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      students.addToGroup(a, inB.student.id, { groupId: w.A.g1.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Refused BEFORE anything was written — a 404 read back after the fact would not do.
    const untouched = await prisma.academyStudent.findUniqueOrThrow({
      where: { id: inB.student.id },
    });
    expect(untouched).toMatchObject({ fullName: 'في المركز ب', status: 'ACTIVE', leftAt: null });
    expect(
      await prisma.groupMembership.count({ where: { studentId: inB.student.studentId } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { entityId: inB.student.id, academyId: w.A.acad.id } }),
    ).toBe(0);
  });
});

describe('C1 — who may do what (real guards)', () => {
  it('reception reads and registers; the owner too', async () => {
    if (!guard()) return;
    const w = await world();
    for (const who of [w.reception.jwt, w.A.owner.jwt]) {
      await expect(viaGuards(who, w.A.acad.id, 'list')).resolves.toBeDefined();
      await expect(viaGuards(who, w.A.acad.id, 'register')).resolves.toBeDefined();
      await expect(viaGuards(who, w.A.acad.id, 'preview')).resolves.toBeDefined();
      await expect(viaGuards(who, w.A.acad.id, 'export')).resolves.toBeDefined();
    }
  });

  it('a Center teacher gets neither the directory nor registration by default', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of [
      'list',
      'register',
      'export',
      'preview',
      'commit',
      'get',
      'withdraw',
      'addToGroup',
    ] as const) {
      await expect(viaGuards(w.teacher.jwt, w.A.acad.id, m)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    // ...and Student 360 still shows them only their own course's students.
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx);
    const teacherScope = await scopes.forContext(await ctxOf(w.teacher.jwt, w.A.acad.id));
    await expect(staff.student(teacherScope, student.studentId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(staff.student(teacherScope, w.omar.studentId)).resolves.toMatchObject({
      id: w.omar.studentId,
    });
  });

  it('reception gains nothing owner-only, and nothing in another academy', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    for (const cap of [
      'academy.manage',
      'member.manage',
      'wallet.withdraw',
      'wallet.read',
      'payment.collect',
      'payment.verify',
      'analytics.read',
      'room.manage',
      'live.manage',
      'assessment.author',
      'group.manage',
    ] as const) {
      expect({ cap, can: ctx.can(cap) }).toEqual({ cap, can: false });
    }
    // Reception of A naming B in the header is not a member there.
    await expect(viaGuards(w.reception.jwt, w.B.acad.id, 'list')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('the flag gates the API, not just the menu', async () => {
    if (!guard()) return;
    const w = await world();
    await flags.setFlag(w.A.acad.id, 'studentRegistry', false, w.A.owner.userId);
    await expect(viaGuards(w.A.owner.jwt, w.A.acad.id, 'list')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(viaGuards(w.reception.jwt, w.A.acad.id, 'register')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const ctl = new CenterStudentsController(students, imports, flags, prisma);
    expect(await ctl.access(await ctxOf(w.A.owner.jwt, w.A.acad.id))).toEqual({
      enabled: false,
      canView: false,
      canRegister: false,
    });
    await flags.setFlag(w.A.acad.id, 'studentRegistry', true, w.A.owner.userId);
    expect(await ctl.access(await ctxOf(w.teacher.jwt, w.A.acad.id))).toEqual({
      enabled: true,
      canView: false,
      canRegister: false,
    });
  });

  it('a student account holding a membership gets nothing', async () => {
    if (!guard()) return;
    const w = await world();
    await prisma.academyMembership.create({
      data: { userId: w.omar.userId, academyId: w.A.acad.id, role: 'STUDENT', status: 'ACTIVE' },
    });
    // Refused by the membership guard or the capability check — either way, nothing.
    await expect(
      viaGuards(jwt(w.omar.userId, Role.STUDENT), w.A.acad.id, 'list'),
    ).rejects.toThrow();
  });
});

describe('C1 — Student 360', () => {
  it('the desk opens a register learner who has no course; the record carries the register data', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx, { guardianName: 'محمد علي', school: 'مدرسة' });
    const s = await scopes.forContext(ctx);
    await expect(staff.student(s, student.studentId)).resolves.toMatchObject({
      id: student.studentId,
      courses: [],
    });
    expect(await students.forStudent(ctx, student.studentId)).toMatchObject({
      code: student.code,
      guardianName: 'محمد علي',
      school: 'مدرسة',
      source: 'DESK',
    });
  });
});

describe('C1 — the register is complete', () => {
  it('an online enrollment registers its student (trigger), once, and never blocks the enrollment', async () => {
    if (!guard()) return;
    const w = await world();
    const rec = await prisma.academyStudent.findUnique({
      where: { academyId_studentId: { academyId: w.A.acad.id, studentId: w.omar.studentId } },
    });
    expect(rec).toMatchObject({ source: 'ONLINE', status: 'ACTIVE', fullName: `عمر خالد ${w.k}` });
    expect(isValidStudentCode(rec!.code)).toBe(true);
    // A second course in the same academy does not add a second record.
    const c2 = await prisma.course.create({
      data: {
        tenantId: w.course.tenantId,
        academyId: w.A.acad.id,
        title: `Chem ${w.k}`,
        status: 'PUBLISHED',
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: w.omar.studentId,
        courseId: c2.id,
        tenantId: w.course.tenantId,
        academyId: w.A.acad.id,
        status: 'ACTIVE',
      },
    });
    expect(
      await prisma.academyStudent.count({
        where: { academyId: w.A.acad.id, studentId: w.omar.studentId },
      }),
    ).toBe(1);
    // A withdrawn learner who enrols again online stays withdrawn: the desk decides.
    await students.withdraw(await ctxOf(w.A.owner.jwt, w.A.acad.id), rec!.id);
    const c3 = await prisma.course.create({
      data: {
        tenantId: w.course.tenantId,
        academyId: w.A.acad.id,
        title: `Bio ${w.k}`,
        status: 'PUBLISHED',
      },
    });
    await prisma.enrollment.create({
      data: {
        studentId: w.omar.studentId,
        courseId: c3.id,
        tenantId: w.course.tenantId,
        academyId: w.A.acad.id,
        status: 'ACTIVE',
      },
    });
    expect((await prisma.academyStudent.findUniqueOrThrow({ where: { id: rec!.id } })).status).toBe(
      'WITHDRAWN',
    );
  });

  it('the name key is derived by the database, whatever a writer puts in it', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const { student } = await register(ctx, { fullName: 'فاطمة الزهراء' });
    await prisma.academyStudent.update({
      where: { id: student.id },
      data: { nameNormalized: 'forged' },
    });
    const row = await prisma.academyStudent.findUniqueOrThrow({ where: { id: student.id } });
    expect(row.nameNormalized).toBe('فاطمه الزهراء');
  });
});

describe('C1 — import', () => {
  const sheet = (w: Awaited<ReturnType<typeof world>>) => [
    {
      row: 2,
      fullName: 'كريم سامي',
      guardianPhone: '01200000001',
      grade: '3 ثانوي',
      group: 'group a a',
    },
    { row: 3, fullName: 'نور سامي', guardianPhone: '01200000001', grade: 'الصف الثالث الثانوي' }, // sibling
    { row: 4, fullName: 'رنا عادل', studentPhone: '123', grade: 'تانية ثانوي' }, // bad phone
    { row: 5, fullName: 'هادي فؤاد', grade: 'سابعة جامعة' }, // unknown year
    { row: 6, fullName: 'سلمى يحيى', grade: 'Prep 1', group: 'Group Z' }, // unknown group
    { row: 7, fullName: 'كريم  سامي', guardianPhone: '٠١٢٠٠٠٠٠٠٠١' }, // duplicate of row 2
    { row: 8, fullName: '', guardianPhone: '01200000009' }, // no name
    { row: 9, fullName: 'بلا تليفون', grade: 'sec-1', group: w.B.g1.name }, // B's group name: not found in A
  ];

  it('previews every row by the desk rules, and writes nothing to the register', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const before = await prisma.academyStudent.count({ where: { academyId: w.A.acad.id } });
    const p = await imports.preview(ctx, { fileName: 'center.xlsx', rows: sheet(w) } as any);
    const byRow = new Map(p.rows.map((r) => [r.row, r]));
    expect(byRow.get(2)).toMatchObject({
      status: 'OK',
      data: { groupId: w.A.g1.id, gradeName: 'الثالث الثانوي' },
    });
    expect(byRow.get(3)!.status).toBe('OK');
    expect(byRow.get(4)).toMatchObject({
      status: 'ERROR',
      issues: [{ field: 'studentPhone', code: 'INVALID_PHONE' }],
    });
    expect(byRow.get(5)!.issues).toContainEqual({ field: 'grade', code: 'GRADE_NOT_FOUND' });
    expect(byRow.get(6)!.issues).toContainEqual({ field: 'group', code: 'GROUP_NOT_FOUND' });
    expect(byRow.get(7)!.issues).toContainEqual({ field: 'row', code: 'DUPLICATE_IN_FILE' });
    expect(byRow.get(8)!.issues).toContainEqual({ field: 'fullName', code: 'NAME_REQUIRED' });
    expect(byRow.get(9)!.issues).toContainEqual({ field: 'group', code: 'GROUP_NOT_FOUND' });
    expect(p.validRows).toBe(2);
    expect(await prisma.academyStudent.count({ where: { academyId: w.A.acad.id } })).toBe(before);
  });

  it('a double commit, concurrent or repeated, imports once; the stored rows are then purged', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const p = await imports.preview(ctx, { rows: sheet(w) } as any);
    const outs = await Promise.allSettled([
      imports.commit(ctx, p.id),
      imports.commit(ctx, p.id),
      imports.commit(ctx, p.id),
    ]);
    const ok = outs.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const busy = outs.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(busy.every((b) => b.reason.getResponse().code === 'IMPORT_COMMIT_IN_PROGRESS')).toBe(
      true,
    );
    const final = await imports.commit(ctx, p.id); // a later retry just reports
    expect(final).toMatchObject({ status: 'COMMITTED', createdCount: 2, skippedCount: 0 });
    expect(
      await prisma.academyStudent.count({ where: { academyId: w.A.acad.id, source: 'IMPORT' } }),
    ).toBe(2);
    const stored = await prisma.studentImport.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.rows).toBeNull();
    expect(JSON.stringify(stored.results)).not.toMatch(/كريم|01200000001/);
    const karim = (await students.list(ctx, { q: 'كريم سامي' })).items[0];
    expect(karim).toMatchObject({ source: 'IMPORT', groups: [{ id: w.A.g1.id }] });
    expect(
      await prisma.auditLog.count({ where: { action: 'student.import', entityId: p.id } }),
    ).toBe(1);
  });

  it('the same file again: every row is recognised as already registered, nothing duplicated', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const first = await imports.preview(ctx, { rows: sheet(w) } as any);
    await imports.commit(ctx, first.id);
    const second = await imports.preview(ctx, { rows: sheet(w) } as any);
    expect(second.alreadyImportedAt).not.toBeNull();
    expect(second.validRows).toBe(0);
    expect(second.counts.DUPLICATE).toBe(2);
    await imports.commit(ctx, second.id);
    expect(
      await prisma.academyStudent.count({ where: { academyId: w.A.acad.id, source: 'IMPORT' } }),
    ).toBe(2);
  });

  it('a commit that dies half-way resumes without writing anyone twice', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const rows = Array.from({ length: 250 }, (_, i) => ({
      row: i + 2,
      fullName: `مستورد ${w.k} ${i}`,
    }));
    const p = await imports.preview(ctx, { rows } as any);
    const original = (imports as any).freshCodes.bind(imports);
    let calls = 0;
    const spy = jest.spyOn(imports as any, 'freshCodes').mockImplementation((...args: any[]) => {
      calls++;
      if (calls === 2) throw new Error('crash in chunk 2');
      return original(...args);
    });
    await expect(imports.commit(ctx, p.id)).rejects.toThrow('crash in chunk 2');
    spy.mockRestore();
    expect(
      await prisma.academyStudent.count({ where: { academyId: w.A.acad.id, source: 'IMPORT' } }),
    ).toBe(100);
    const done = await imports.commit(ctx, p.id);
    expect(done).toMatchObject({ status: 'COMMITTED', createdCount: 250 });
    expect(
      await prisma.academyStudent.count({ where: { academyId: w.A.acad.id, source: 'IMPORT' } }),
    ).toBe(250);
  });

  it("another academy's import cannot be read or committed", async () => {
    if (!guard()) return;
    const w = await world();
    const a = await ctxOf(w.A.owner.jwt, w.A.acad.id);
    const b = await ctxOf(w.B.owner.jwt, w.B.acad.id);
    const p = await imports.preview(b, { rows: [{ row: 2, fullName: 'من ب' }] } as any);
    await expect(imports.commit(a, p.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(imports.get(a, p.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await prisma.studentImport.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
      'PREVIEWED',
    );
  });

  it('1,000 rows preview and commit in reasonable time', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      row: i + 2,
      fullName: `طالب ${w.k} رقم ${i}`,
      guardianPhone: `0100${String(1_000_000 + i).slice(-7)}`,
      grade: ['1 ثانوي', '2 ثانوي', '3 ثانوي'][i % 3],
      group: i % 2 ? w.A.g1.name : '',
    }));
    const t0 = Date.now();
    const p = await imports.preview(ctx, { rows } as any);
    const t1 = Date.now();
    const done = await imports.commit(ctx, p.id);
    const t2 = Date.now();
    expect(p.validRows).toBe(1000);
    expect(done.createdCount).toBe(1000);
    const codesSeen = await prisma.academyStudent.findMany({
      where: { academyId: w.A.acad.id },
      select: { code: true },
    });
    expect(new Set(codesSeen.map((c) => c.code)).size).toBe(codesSeen.length);
    console.log(`[c1-perf] 1000-row preview ${t1 - t0}ms, commit ${t2 - t1}ms`);
    expect(t2 - t0).toBeLessThan(60_000);
  }, 120_000);
});

describe('C1 — export', () => {
  it('is Excel-ready Arabic CSV of this academy only, with spreadsheet formulas neutralised', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    await register(ctx, { fullName: '=HYPERLINK("http://x","y")', guardianPhone: '01066667777' });
    await register(await ctxOf(w.B.owner.jwt, w.B.acad.id), { fullName: 'سري في ب' });
    const { csv } = await students.exportCsv(ctx);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csv).toContain('"010 6666 7777"');
    expect(csv).not.toContain('سري في ب');
    expect(csv).not.toMatch(/c[a-z0-9]{24}/); // no internal ids
  });
});

describe('C1 — no financial side effects, and platform metrics stay honest', () => {
  it('registering, importing, grouping and withdrawing write nothing financial', async () => {
    if (!guard()) return;
    const w = await world();
    const count = async () =>
      Promise.all([
        prisma.payment.count(),
        prisma.paymentEvent.count(),
        prisma.ledgerTransaction.count(),
        prisma.ledgerEntry.count(),
        prisma.walletTransaction.count(),
        prisma.payoutRequest.count(),
        prisma.livePurchase.count(),
        prisma.commercialTerms.count(),
        prisma.coupon.aggregate({ _sum: { usedCount: true } }).then((a) => a._sum.usedCount ?? 0),
        prisma.enrollment.count(),
      ]);
    const before = await count();
    const ctx = await ctxOf(w.reception.jwt, w.A.acad.id);
    const { student } = await register(ctx, { groupId: w.A.g1.id });
    await students.addToGroup(ctx, student.id, { groupId: w.A.g2.id });
    await students.update(ctx, student.id, { school: 'x' });
    await students.withdraw(ctx, student.id);
    await students.reactivate(ctx, student.id);
    const p = await imports.preview(ctx, { rows: [{ row: 2, fullName: 'مالي صفر' }] } as any);
    await imports.commit(ctx, p.id);
    await students.exportCsv(ctx);
    expect(await count()).toEqual(before);
  });

  it("the platform's online-student count ignores desk-registered learners", async () => {
    if (!guard()) return;
    const w = await world();
    const admin = new AdminService(
      prisma,
      { platformTotals: async () => ({ grossCents: 0, commissionCents: 0 }) } as any,
      {} as any,
      {} as any,
    );
    const before = (await admin.overview()).students;
    await register(await ctxOf(w.reception.jwt, w.A.acad.id));
    expect((await admin.overview()).students).toBe(before);
  });
});

describe('C1 — one normaliser, one code rule (the database)', () => {
  it('folds the spellings a desk meets into one key', async () => {
    if (!guard()) return;
    const same: [string, string][] = [
      ['أَحْمَدُ   مُحَمَّد', 'احمد محمد'],
      ['إسلام آدم', 'اسلام ادم'],
      ['فاطمة', 'فاطمه'],
      ['مصطفى', 'مصطفي'],
      ['عبد الرحمن', 'عبدالرحمن'],
      ['محمـــــد', 'محمد'],
      ['يوسف\u00A0علي', 'يوسف علي'],
      ['ی\u200Fوسف', 'يوسف'],
      ['Ahmed  MOHAMED', 'ahmed mohamed'],
    ];
    for (const [a, b] of same) {
      const [{ ka, kb }] = await prisma.$queryRaw<{ ka: string; kb: string }[]>`
        SELECT academy_student_name_key(${a}) AS ka, academy_student_name_key(${b}) AS kb`;
      expect({ a, key: ka }).toEqual({ a, key: kb });
    }
  });

  it('codes the database generates pass the API check, and the API codes pass the database', async () => {
    if (!guard()) return;
    const rows = await prisma.$queryRaw<{ c: string }[]>`
      SELECT academy_student_new_code() AS c FROM generate_series(1, 2000)`;
    expect(rows.every((r) => isValidStudentCode(r.c))).toBe(true);
    const api = Array.from({ length: 2000 }, () => codes.generateStudentCode());
    const [{ ok }] = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT bool_and(academy_student_code_ok(c)) AS ok FROM unnest(${api}::text[]) AS c`;
    expect(ok).toBe(true);
  });
});

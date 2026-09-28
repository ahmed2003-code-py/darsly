import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { InvitationLinksService } from '../academy/invitation-links.service';
import { StaffScopeService } from '../academy/staff-scope.service';
import { TeamController } from '../academy/team.controller';
import { TeamService } from '../academy/team.service';
import { AssignmentsService } from '../assessments/assignments.service';
import { StaffGradingController } from '../assessments/staff-grading.controller';
import { ConversationPolicy } from '../chat/conversation-policy';
import { ChatService } from '../chat/chat.service';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Phase 1 — assistant authorization, against a real PostgreSQL and the real
 * guards. Every "cannot" here is asked the way an attacker would ask it: the
 * route's own guards with a hand-picked X-Academy-Id, or the service with an
 * id copied from somewhere it should not work.
 *
 * The world: one academy with Physics and Chemistry. Ahmed is an assistant
 * with Physics only. Sara takes Physics; Omar takes only Chemistry; Mona
 * takes both. A second academy has its own student, Laila.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-signed-links-0123456789';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const scopes = new StaffScopeService(prisma, academy);
const team = new TeamService(prisma);
const staff = new StaffService(prisma, scopes, new ConversationPolicy(prisma, scopes));
const links = new InvitationLinksService(prisma, team);
const notifications = { create: async () => ({}), upsertForThread: async () => ({}) } as any;
const realtime = { emitToUser: () => undefined, emitToThread: () => undefined } as any;
const chat = new ChatService(
  prisma,
  realtime,
  notifications,
  {} as any,
  scopes,
  new ConversationPolicy(prisma, scopes),
);
const assignments = new AssignmentsService(
  prisma,
  {} as any,
  notifications,
  {} as any,
  { record: async () => ({}) } as any,
);

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, [
    'academyMembership',
    'membershipCourse',
    'academyInvitationLink',
    'chatThread',
    'assignmentSubmission',
  ]);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;

const jwt = (sub: string, role: Role, tenantId?: string) =>
  ({ sub, role, tenantId, sessionId: 's' }) as JwtPayload;

async function makeStudent(k: string, name: string) {
  const u = await prisma.user.create({
    data: { role: 'STUDENT', fullName: `${name} ${k}`, email: `p1-${name}-${k}@it.test` },
  });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  return { userId: u.id, studentId: sp.id, jwt: jwt(u.id, Role.STUDENT) };
}
async function enroll(studentId: string, course: { id: string; tenantId: string }) {
  await prisma.enrollment.create({
    data: {
      studentId,
      courseId: course.id,
      tenantId: course.tenantId,
      academyId: course.tenantId,
      status: 'ACTIVE',
    },
  });
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `p1-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `p1-t-${k}`, status: 'APPROVED', acceptsStudentMessages: true },
  });
  const acad = await prisma.academy.create({
    data: { id: tp.id, slug: `p1-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: tUser.id, academyId: acad.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const physics = await prisma.course.create({
    data: { tenantId: tp.id, academyId: acad.id, title: `Physics ${k}`, status: 'PUBLISHED' },
  });
  const chemistry = await prisma.course.create({
    data: { tenantId: tp.id, academyId: acad.id, title: `Chemistry ${k}`, status: 'PUBLISHED' },
  });

  // Another academy, with a student of its own.
  const oUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Other ${k}`, email: `p1-o-${k}@it.test` },
  });
  const otp = await prisma.teacherProfile.create({
    data: { userId: oUser.id, slug: `p1-o-${k}`, status: 'APPROVED', acceptsStudentMessages: true },
  });
  const other = await prisma.academy.create({
    data: { id: otp.id, slug: `p1-o-${k}`, name: `Other ${k}`, ownerUserId: oUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: oUser.id, academyId: other.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const otherCourse = await prisma.course.create({
    data: { tenantId: otp.id, academyId: other.id, title: `Other ${k}`, status: 'PUBLISHED' },
  });

  const sara = await makeStudent(k, 'sara');
  const omar = await makeStudent(k, 'omar');
  const mona = await makeStudent(k, 'mona');
  const laila = await makeStudent(k, 'laila');
  await enroll(sara.studentId, physics);
  await enroll(omar.studentId, chemistry);
  await enroll(mona.studentId, physics);
  await enroll(mona.studentId, chemistry);
  await enroll(laila.studentId, otherCourse);

  // Ahmed joins through the owner's invitation link, as a STAFF account.
  const link = await links.create(acad.id, tUser.id, 'ASSISTANT', {
    title: 'Student Support',
    permissions: ['student.view', 'progress.view', 'message.reply'],
    courseScope: 'SELECTED',
    courseIds: [physics.id],
    directContact: true,
  });
  const aUser = await prisma.user.create({
    data: { role: 'STAFF', fullName: `Ahmed ${k}`, email: `p1-a-${k}@it.test` },
  });
  const membership = await prisma.$transaction((tx) =>
    links.claimForNewUser(
      tx,
      require('crypto').createHash('sha256').update(link.token).digest('hex'),
      aUser.id,
    ),
  );

  const owner = { userId: tUser.id, jwt: jwt(tUser.id, Role.TEACHER, tp.id) };
  const ahmed = { userId: aUser.id, membershipId: membership.id, jwt: jwt(aUser.id, Role.STAFF) };
  return { k, acad, other, physics, chemistry, owner, ahmed, sara, omar, mona, laila };
}

/** Run a route's real guards the way Nest would, for this caller and academy header. */
async function viaGuards(
  user: JwtPayload,
  academyId: string,
  controller: any,
  method: string,
  params: Record<string, string> = {},
) {
  const req: any = { user, headers: { 'x-academy-id': academyId }, params };
  const handler = controller.prototype[method];
  const exec: any = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  };
  await new AcademyMembershipGuard(academy).canActivate(exec);
  new PermissionGuard(new Reflector()).canActivate(exec);
  return req.academyContext;
}
const scopeFor = async (user: JwtPayload, academyId: string) =>
  scopes.forContext((await academy.buildContext(user.sub, academyId, user.role))!);
const setGrant = (w: Awaited<ReturnType<typeof world>>, over: Partial<any>) =>
  team.update({ academyId: w.acad.id, userId: w.owner.userId } as any, w.ahmed.membershipId, {
    title: 'Student Support',
    permissions: ['student.view', 'progress.view', 'message.reply'],
    courseScope: 'SELECTED',
    courseIds: [w.physics.id],
    directContact: true,
    ...over,
  });

describe('Phase 1 — assistant scope', () => {
  it('joins as themselves: a STAFF account, no teacher profile, exactly the grant on the link', async () => {
    if (!guard()) return;
    const w = await world();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: w.ahmed.userId },
      include: { teacherProfile: true },
    });
    expect(user.role).toBe('STAFF');
    expect(user.teacherProfile).toBeNull();
    const m = await prisma.academyMembership.findUniqueOrThrow({
      where: { id: w.ahmed.membershipId },
      include: { courses: true },
    });
    expect(m).toMatchObject({
      role: 'ASSISTANT',
      title: 'Student Support',
      courseScope: 'SELECTED',
    });
    expect(m.courses.map((c) => c.courseId)).toEqual([w.physics.id]);
  });

  it('sees the allowed course, and not the other one', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await scopeFor(w.ahmed.jwt, w.acad.id);
    const mine = await staff.courses(s);
    expect(mine.map((c) => c.id)).toEqual([w.physics.id]);
    await expect(scopes.assertCourse(s, w.chemistry.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(staff.students(s, { courseId: w.chemistry.id })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('sees only students of allowed courses — and of a shared student, only the allowed course', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await scopeFor(w.ahmed.jwt, w.acad.id);
    const { items } = await staff.students(s, {});
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual([w.sara.studentId, w.mona.studentId].sort());
    const mona = items.find((i) => i.id === w.mona.studentId)!;
    expect(mona.courses.map((c) => c.id)).toEqual([w.physics.id]);
  });

  it('a stale or typed URL for a student outside scope is a 404, detail and progress alike', async () => {
    if (!guard()) return;
    const w = await world();
    const s = await scopeFor(w.ahmed.jwt, w.acad.id);
    for (const id of [w.omar.studentId, w.laila.studentId, 'not-a-student']) {
      await expect(staff.student(s, id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(staff.progress(s, id)).rejects.toBeInstanceOf(NotFoundException);
    }
    const progress = await staff.progress(s, w.mona.studentId);
    expect(progress.map((p) => p.course.id)).toEqual([w.physics.id]);
  });

  it('removing the course takes access away on the very next request', async () => {
    if (!guard()) return;
    const w = await world();
    const before = await scopeFor(w.ahmed.jwt, w.acad.id);
    await expect(staff.student(before, w.sara.studentId)).resolves.toMatchObject({
      id: w.sara.studentId,
    });
    const sent = await chat.sendMessage(w.ahmed.jwt, {
      academyId: w.acad.id,
      studentId: w.sara.studentId,
      body: 'hello',
    });

    await setGrant(w, { courseIds: [w.chemistry.id] });

    const after = await scopeFor(w.ahmed.jwt, w.acad.id);
    await expect(staff.student(after, w.sara.studentId)).rejects.toBeInstanceOf(NotFoundException);
    expect((await staff.students(after, {})).items.map((i) => i.id).sort()).toEqual(
      [w.omar.studentId, w.mona.studentId].sort(),
    );
    // The conversation with Sara closes to him too — same account, same thread id.
    expect(await chat.canAccessThread(w.ahmed.jwt, sent.threadId)).toBe(false);
    await expect(
      chat.sendMessage(w.ahmed.jwt, { threadId: sent.threadId, body: 'still here?' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await chat.listThreads(w.ahmed.jwt)).toHaveLength(0);

    // …and assigning a course brings the right students back.
    await setGrant(w, { courseIds: [w.physics.id, w.chemistry.id] });
    const both = await scopeFor(w.ahmed.jwt, w.acad.id);
    expect((await staff.students(both, {})).items).toHaveLength(3);
    expect(await chat.canAccessThread(w.ahmed.jwt, sent.threadId)).toBe(true);
  });

  it('removing a capability removes that action on the next request', async () => {
    if (!guard()) return;
    const w = await world();
    await viaGuards(w.ahmed.jwt, w.acad.id, StaffController, 'progress');
    await setGrant(w, { permissions: ['student.view', 'message.reply'] });
    await expect(
      viaGuards(w.ahmed.jwt, w.acad.id, StaffController, 'progress'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await setGrant(w, { permissions: ['student.view'] });
    await expect(
      chat.sendMessage(w.ahmed.jwt, {
        academyId: w.acad.id,
        studentId: w.sara.studentId,
        body: 'hi',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot reach the Team routes — so cannot change their own permissions', async () => {
    if (!guard()) return;
    const w = await world();
    for (const m of ['list', 'update', 'courses']) {
      await expect(viaGuards(w.ahmed.jwt, w.acad.id, TeamController, m)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    // And even with owner authority, nobody edits their own membership.
    await expect(
      team.update({ academyId: w.acad.id, userId: w.ahmed.userId } as any, w.ahmed.membershipId, {
        title: 'Boss',
        permissions: ['student.view'],
        courseScope: 'ALL',
        courseIds: [],
        directContact: true,
      }),
    ).rejects.toMatchObject({ response: { code: 'SELF_EDIT' } });
  });

  it('cannot be escalated — not through the Team screen, not by a hand-edited row', async () => {
    if (!guard()) return;
    const w = await world();
    for (const cap of [
      'member.manage',
      'wallet.read',
      'wallet.withdraw',
      'course.write',
      'payment.collect',
      'payment.verify',
      'academy.manage',
    ]) {
      await expect(setGrant(w, { permissions: ['student.view', cap] })).rejects.toMatchObject({
        response: { code: 'CAPABILITY_NOT_GRANTABLE' },
      });
    }
    await prisma.academyMembership.update({
      where: { id: w.ahmed.membershipId },
      data: {
        permissions: [
          'member.manage',
          'wallet.read',
          'course.write',
          'payment.collect',
          'live.manage',
          'student.manage',
          'student.view',
        ],
      },
    });
    const ctx = (await academy.buildContext(w.ahmed.userId, w.acad.id, Role.STAFF))!;
    for (const cap of [
      'member.manage',
      'wallet.read',
      'course.write',
      'payment.collect',
    ] as const) {
      expect(ctx.can(cap)).toBe(false);
    }
    // Academy-wide capabilities are off for someone limited to some courses.
    expect(ctx.can('live.manage')).toBe(false);
    expect(ctx.can('student.manage')).toBe(false);
    expect(ctx.can('student.view')).toBe(true);
  });

  it('cannot act in another academy, nor see its students', async () => {
    if (!guard()) return;
    const w = await world();
    await expect(
      viaGuards(w.ahmed.jwt, w.other.id, StaffController, 'students'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(viaGuards(w.ahmed.jwt, w.other.id, TeamController, 'list')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const s = await scopeFor(w.ahmed.jwt, w.acad.id);
    await expect(staff.student(s, w.laila.studentId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      chat.sendMessage(w.ahmed.jwt, {
        academyId: w.other.id,
        studentId: w.laila.studentId,
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Naming his own academy does not reach her either.
    await expect(
      chat.sendMessage(w.ahmed.jwt, {
        academyId: w.acad.id,
        studentId: w.laila.studentId,
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('messages as himself — "Ahmed · Student Support" — never as the teacher', async () => {
    if (!guard()) return;
    const w = await world();
    const sent = await chat.sendMessage(w.ahmed.jwt, {
      academyId: w.acad.id,
      studentId: w.sara.studentId,
      body: 'Hi Sara, how is the homework?',
    });
    expect(sent.message.sender).toMatchObject({
      id: w.ahmed.userId,
      kind: 'ASSISTANT',
      title: 'Student Support',
    });
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: sent.threadId } });
    expect(thread.staffUserId).toBe(w.ahmed.userId);
    // The student sees Ahmed, as an assistant, with his title.
    const [row] = await chat.listThreads(w.sara.jwt);
    expect(row).toMatchObject({
      counterpartKind: 'ASSISTANT',
      counterpartTitle: 'Student Support',
    });
    expect(row.counterpartName).toContain('Ahmed');
    // The student answers; it lands with Ahmed, not in the teacher's inbox.
    const reply = await chat.sendMessage(w.sara.jwt, { threadId: sent.threadId, body: 'fine!' });
    expect(reply.message.sender?.kind).toBe('STUDENT');
    expect((await chat.listThreads(w.ahmed.jwt)).map((t) => t.id)).toEqual([sent.threadId]);
    expect((await chat.listThreads(w.owner.jwt)).map((t) => t.id)).not.toContain(sent.threadId);
    expect(await chat.canAccessThread(w.owner.jwt, sent.threadId)).toBe(false);
    // A later title change does not rewrite what was said as what.
    await setGrant(w, { title: 'Academic Assistant' });
    const history = await chat.getMessages(w.sara.jwt, sent.threadId);
    expect(history[0].sender?.title).toBe('Student Support');
  });

  it('directContact=false: not offered to the student, and refused if asked anyway', async () => {
    if (!guard()) return;
    const w = await world();
    const offered = await chat.contacts(w.sara.jwt);
    expect(offered.some((c) => c.kind === 'ASSISTANT' && c.staffUserId === w.ahmed.userId)).toBe(
      true,
    );
    // Omar is not in Physics: Ahmed is not his to reach even with directContact on.
    expect((await chat.contacts(w.omar.jwt)).some((c) => c.kind === 'ASSISTANT')).toBe(false);
    await expect(
      chat.sendMessage(w.omar.jwt, {
        academyId: w.acad.id,
        staffUserId: w.ahmed.userId,
        body: 'x',
      }),
    ).rejects.toMatchObject({ response: { code: 'ASSISTANT_NOT_REACHABLE' } });

    await setGrant(w, { directContact: false });
    expect((await chat.contacts(w.sara.jwt)).some((c) => c.kind === 'ASSISTANT')).toBe(false);
    await expect(
      chat.sendMessage(w.sara.jwt, {
        academyId: w.acad.id,
        staffUserId: w.ahmed.userId,
        body: 'x',
      }),
    ).rejects.toMatchObject({ response: { code: 'ASSISTANT_NOT_REACHABLE' } });
    // He can still write to her first, and she can answer that.
    const sent = await chat.sendMessage(w.ahmed.jwt, {
      academyId: w.acad.id,
      studentId: w.sara.studentId,
      body: 'checking in',
    });
    await expect(
      chat.sendMessage(w.sara.jwt, { threadId: sent.threadId, body: 'thanks' }),
    ).resolves.toBeTruthy();
  });

  it('payments are unreachable unless granted, and then only for his courses', async () => {
    if (!guard()) return;
    const w = await world();
    await expect(
      viaGuards(w.ahmed.jwt, w.acad.id, StaffController, 'payments'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    for (const course of [w.physics, w.chemistry]) {
      await prisma.payment.create({
        data: {
          studentId: w.mona.studentId,
          courseId: course.id,
          tenantId: course.tenantId,
          academyId: w.acad.id,
          amountCents: 10000,
          gateway: 'manual',
          status: 'PENDING',
        },
      });
    }
    await setGrant(w, { permissions: ['student.view', 'payment.view'] });
    await viaGuards(w.ahmed.jwt, w.acad.id, StaffController, 'payments');
    const rows = await staff.payments(await scopeFor(w.ahmed.jwt, w.acad.id));
    expect(rows.map((r) => r.course?.id)).toEqual([w.physics.id]);
    // Still no wallet, whatever else he holds.
    const ctx = (await academy.buildContext(w.ahmed.userId, w.acad.id, Role.STAFF))!;
    expect(ctx.can('wallet.read')).toBe(false);
  });

  it('marks only in his courses, and the mark carries his identity', async () => {
    if (!guard()) return;
    const w = await world();
    const submission = async (course: { id: string }, studentId: string) => {
      const unit = await prisma.courseUnit.create({ data: { courseId: course.id, title: 'U' } });
      const lesson = await prisma.lesson.create({
        data: { unitId: unit.id, title: 'L', type: 'ASSIGNMENT' },
      });
      const a = await prisma.assignment.create({
        data: { lessonId: lesson.id, prompt: 'Explain', maxScore: 10 },
      });
      return prisma.assignmentSubmission.create({
        data: { assignmentId: a.id, studentId, body: 'my answer' },
      });
    };
    const phys = await submission(w.physics, w.sara.studentId);
    const chem = await submission(w.chemistry, w.omar.studentId);
    await expect(
      viaGuards(w.ahmed.jwt, w.acad.id, StaffGradingController, 'gradeSubmission'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await setGrant(w, { permissions: ['student.view', 'assessment.grade'] });
    await viaGuards(w.ahmed.jwt, w.acad.id, StaffGradingController, 'gradeSubmission');
    const courses = (await scopeFor(w.ahmed.jwt, w.acad.id)).courses;
    await assignments.gradeSubmission(courses, w.ahmed.userId, phys.id, { score: 7 } as any);
    const marked = await prisma.assignmentSubmission.findUniqueOrThrow({ where: { id: phys.id } });
    expect(marked).toMatchObject({ score: 7, gradedBy: w.ahmed.userId });
    await expect(
      assignments.gradeSubmission(courses, w.ahmed.userId, chem.id, { score: 7 } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the Team screen refuses a course from another academy', async () => {
    if (!guard()) return;
    const w = await world();
    const otherCourse = await prisma.course.findFirstOrThrow({ where: { academyId: w.other.id } });
    await expect(setGrant(w, { courseIds: [w.physics.id, otherCourse.id] })).rejects.toMatchObject({
      response: { code: 'COURSE_NOT_IN_ACADEMY' },
    });
  });
});

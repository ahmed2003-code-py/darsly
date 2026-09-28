import {
  ExecutionContext,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyService } from '../academy/academy.service';
import { StaffScopeService } from '../academy/staff-scope.service';
import { AuthConfig } from '../auth/auth.config';
import { TokenService } from '../auth/token.service';
import { ConversationPolicy } from '../chat/conversation-policy';
import { ChatService } from '../chat/chat.service';
import { ChatReactionsService } from '../chat/chat-reactions.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GUARDIAN_ALLOWED_KEY } from '../common/decorators/guardian-allowed.decorator';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { StaffService } from '../staff/staff.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { GuardianStaffController } from './guardian.controller';
import { GuardianService } from './guardian.service';

/**
 * Phase 2 — Student Care, against a real PostgreSQL: the shared TEAM inbox
 * and guardians. Every "cannot" is asked the way an attacker would ask it.
 *
 * The world: an academy (owner Mona) with Physics and Chemistry. Sara and
 * Laila take Physics; Omar takes Chemistry. Ahmed is an assistant on
 * Physics with message.inbox + guardian.manage; Nour is an assistant on
 * Physics WITHOUT message.inbox; Karim is an assistant on Chemistry with it.
 * A second academy has its own student, Zein.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const scopes = new StaffScopeService(prisma, academy);
const events: { userId: string; event: string; payload: any }[] = [];
const realtime = {
  emitToUser: (userId: string, event: string, payload: any) =>
    events.push({ userId, event, payload }),
  emitToThread: () => undefined,
} as any;
const notified: { userId: string; threadId: string }[] = [];
const notifications = {
  create: async () => ({}),
  upsertForThread: async (n: any) => {
    notified.push({ userId: n.userId, threadId: n.threadId });
    return {};
  },
} as any;
const chat = new ChatService(
  prisma,
  realtime,
  notifications,
  {} as any,
  scopes,
  new ConversationPolicy(prisma, scopes),
);
const reactions = new ChatReactionsService(prisma, chat, realtime);
const jwt = new JwtService();
const tokens = new TokenService(jwt, prisma, new AuthConfig());
const guardians = new GuardianService(
  prisma,
  scopes,
  tokens,
  new StaffService(prisma, scopes, new ConversationPolicy(prisma, scopes)),
);

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, [
    'chatThread',
    'guardian',
    'guardianLink',
    'guardianAccessToken',
    'membershipCourse',
  ]);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;
const as = (sub: string, role: Role, tenantId?: string, sessionId = 's') =>
  ({ sub, role, tenantId, sessionId }) as JwtPayload;

let phoneSeq = Math.floor(Math.random() * 1e6);
const phone = () => `015${String(10_000_000 + ++phoneSeq).slice(-8)}`;

async function student(
  k: string,
  name: string,
  courses: { id: string; tenantId: string; academyId: string }[],
) {
  const u = await prisma.user.create({
    data: {
      role: 'STUDENT',
      fullName: `${name} ${k}`,
      email: `sc-${name}-${k}@it.test`,
      phone: `+20${phone().slice(1)}`,
    },
  });
  const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
  for (const c of courses) {
    await prisma.enrollment.create({
      data: {
        studentId: sp.id,
        courseId: c.id,
        tenantId: c.tenantId,
        academyId: c.academyId,
        status: 'ACTIVE',
      },
    });
  }
  return { userId: u.id, studentId: sp.id, phone: u.phone!, jwt: as(u.id, Role.STUDENT) };
}

async function assistant(
  k: string,
  name: string,
  academyId: string,
  courseIds: string[],
  permissions: string[],
  directContact = false,
) {
  const u = await prisma.user.create({
    data: { role: 'STAFF', fullName: `${name} ${k}`, email: `sc-${name}-${k}@it.test` },
  });
  const m = await prisma.academyMembership.create({
    data: {
      userId: u.id,
      academyId,
      role: 'ASSISTANT',
      status: 'ACTIVE',
      title: 'Student Support',
      courseScope: 'SELECTED',
      directContact,
      permissions,
    },
  });
  for (const courseId of courseIds) {
    await prisma.membershipCourse.create({ data: { membershipId: m.id, courseId, academyId } });
  }
  return { userId: u.id, membershipId: m.id, jwt: as(u.id, Role.STAFF) };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Mona ${k}`, email: `sc-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `sc-t-${k}`, status: 'APPROVED', acceptsStudentMessages: true },
  });
  await prisma.academy.create({
    data: { id: tp.id, slug: `sc-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: tUser.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const course = async (title: string) => {
    const c = await prisma.course.create({
      data: { tenantId: tp.id, academyId: tp.id, title: `${title} ${k}`, status: 'PUBLISHED' },
    });
    return { id: c.id, tenantId: tp.id, academyId: tp.id };
  };
  const physics = await course('Physics');
  const chemistry = await course('Chemistry');
  const sara = await student(k, 'sara', [physics]);
  const laila = await student(k, 'laila', [physics]);
  const omar = await student(k, 'omar', [chemistry]);
  const ahmed = await assistant(
    k,
    'ahmed',
    tp.id,
    [physics.id],
    ['student.view', 'message.reply', 'message.inbox', 'guardian.manage'],
    true,
  );
  const nour = await assistant(k, 'nour', tp.id, [physics.id], ['student.view', 'message.reply']);
  const karim = await assistant(
    k,
    'karim',
    tp.id,
    [chemistry.id],
    ['student.view', 'message.reply', 'message.inbox'],
  );

  // Another academy, with its own student and owner.
  const oUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Other ${k}`, email: `sc-o-${k}@it.test` },
  });
  const otp = await prisma.teacherProfile.create({
    data: { userId: oUser.id, slug: `sc-o-${k}`, status: 'APPROVED', acceptsStudentMessages: true },
  });
  await prisma.academy.create({
    data: { id: otp.id, slug: `sc-o-${k}`, name: `Other ${k}`, ownerUserId: oUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: oUser.id, academyId: otp.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const otherCourse = await prisma.course.create({
    data: { tenantId: otp.id, academyId: otp.id, title: `Other ${k}`, status: 'PUBLISHED' },
  });
  const zein = await student(k, 'zein', [
    { id: otherCourse.id, tenantId: otp.id, academyId: otp.id },
  ]);
  const otherOwner = {
    userId: oUser.id,
    jwt: as(oUser.id, Role.TEACHER, otp.id),
    academyId: otp.id,
  };

  const owner = { userId: tUser.id, jwt: as(tUser.id, Role.TEACHER, tp.id) };
  return {
    k,
    academyId: tp.id,
    physics,
    chemistry,
    owner,
    sara,
    laila,
    omar,
    ahmed,
    nour,
    karim,
    zein,
    otherOwner,
  };
}
type World = Awaited<ReturnType<typeof world>>;
const scopeOf = async (u: JwtPayload, academyId: string) =>
  scopes.forContext((await academy.buildContext(u.sub, academyId, u.role))!);
const toTeam = (w: World, from: JwtPayload, body: string, extra: object = {}) =>
  chat.sendMessage(from, { academyId: w.academyId, team: true, body, ...extra } as any);

/** Link a guardian as Ahmed would, then sign in with the link. */
async function linkGuardian(w: World, studentId: string, ph = phone(), name = 'Father') {
  const g = await guardians.add(await scopeOf(w.ahmed.jwt, w.academyId), studentId, {
    name,
    phone: ph,
    relationship: 'FATHER',
  });
  const session = await guardians.consume(g.token, {});
  const payload = await jwt.verifyAsync(session.accessToken, {
    secret: process.env.JWT_ACCESS_SECRET,
  });
  return { link: g, token: g.token, session, jwt: payload as JwtPayload, phone: ph };
}

describe('the shared TEAM inbox', () => {
  it('a student reaches the support team: one TEAM conversation, even for simultaneous first sends', async () => {
    if (!guard()) return;
    const w = await world();
    const [a, b] = await Promise.all([
      toTeam(w, w.sara.jwt, 'first'),
      toTeam(w, w.sara.jwt, 'also first'),
    ]);
    expect(a.threadId).toBe(b.threadId);
    const t = await prisma.chatThread.findUniqueOrThrow({ where: { id: a.threadId } });
    expect(t).toMatchObject({
      kind: 'TEAM',
      staffUserId: null,
      guardianUserId: null,
      assigneeUserId: null,
    });
    expect(t.dedupeKey).toBe(`${w.academyId}|${w.sara.studentId}|S|TEAM`);
    expect(
      await prisma.chatThread.count({ where: { studentId: w.sara.studentId, kind: 'TEAM' } }),
    ).toBe(1);
  });

  it('who sees it: inbox + scope — not an assistant without inbox, not one outside the course', async () => {
    if (!guard()) return;
    const w = await world();
    const { threadId } = await toTeam(w, w.sara.jwt, 'help');
    expect(
      (await chat.listThreads(w.ahmed.jwt, { filter: 'unassigned' })).map((t) => t.id),
    ).toEqual([threadId]);
    expect((await chat.listThreads(w.owner.jwt)).map((t) => t.id)).toContain(threadId);
    expect(await chat.listThreads(w.nour.jwt)).toHaveLength(0);
    expect(await chat.canAccessThread(w.nour.jwt, threadId)).toBe(false);
    expect(await chat.canAccessThread(w.karim.jwt, threadId)).toBe(false);
    expect(await chat.canAccessThread(w.otherOwner.jwt, threadId)).toBe(false);
    expect(await chat.canAccessThread(w.laila.jwt, threadId)).toBe(false);
    // Recipients are computed, not "the whole academy".
    expect((await chat.teamStaff(w.academyId, w.sara.studentId)).sort()).toEqual(
      [w.owner.userId, w.ahmed.userId].sort(),
    );
    // Omar's (Chemistry) TEAM conversation is Karim's and the owner's, never Ahmed's.
    const o = await toTeam(w, w.omar.jwt, 'chem?');
    expect(await chat.canAccessThread(w.ahmed.jwt, o.threadId)).toBe(false);
    expect(await chat.canAccessThread(w.karim.jwt, o.threadId)).toBe(true);
  });

  it('claim, reply as himself, resolve, and the learner reopens the SAME conversation', async () => {
    if (!guard()) return;
    const w = await world();
    const { threadId } = await toTeam(w, w.sara.jwt, 'my homework?');
    notified.length = 0;
    await chat.claim(w.ahmed.jwt, threadId);
    await expect(chat.claim(w.owner.jwt, threadId)).rejects.toMatchObject({
      response: { code: 'ALREADY_ASSIGNED' },
    });
    const reply = await chat.sendMessage(w.ahmed.jwt, { threadId, body: 'on it' });
    expect(reply.message.sender).toMatchObject({
      id: w.ahmed.userId,
      kind: 'ASSISTANT',
      title: 'Student Support',
    });
    expect(notified.map((n) => n.userId)).toEqual([w.sara.userId]);
    const seen = await chat.getMessages(w.sara.jwt, threadId);
    expect(seen.map((m) => m.sender?.kind)).toEqual(['STUDENT', 'ASSISTANT']);
    // The learner sees one team destination named by the academy, not a person.
    const [row] = await chat.listThreads(w.sara.jwt);
    expect(row).toMatchObject({ id: threadId, kind: 'TEAM', counterpartName: `Academy ${w.k}` });

    await chat.resolve(w.ahmed.jwt, threadId, true);
    expect((await chat.listThreads(w.ahmed.jwt, { filter: 'resolved' })).map((t) => t.id)).toEqual([
      threadId,
    ]);
    notified.length = 0;
    const again = await toTeam(w, w.sara.jwt, 'one more thing');
    expect(again.threadId).toBe(threadId);
    const t = await prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(t.resolvedAt).toBeNull();
    expect(t.assigneeUserId).toBe(w.ahmed.userId);
    // Assigned: only the assignee is notified, not the whole team.
    expect(notified.map((n) => n.userId)).toEqual([w.ahmed.userId]);
    expect((await chat.listThreads(w.ahmed.jwt, { filter: 'mine' })).map((t) => t.id)).toContain(
      threadId,
    );
  });

  it('while unassigned, every authorized staff member is notified — each in their own inbox', async () => {
    if (!guard()) return;
    const w = await world();
    notified.length = 0;
    await toTeam(w, w.sara.jwt, 'anyone?');
    expect(notified.map((n) => n.userId).sort()).toEqual([w.owner.userId, w.ahmed.userId].sort());
    expect(new Set(notified.map((n) => n.threadId)).size).toBe(1);
  });

  it('reassign and resolve rules: assignee or supervisor (message.oversee) only', async () => {
    if (!guard()) return;
    const w = await world();
    const { threadId } = await toTeam(w, w.sara.jwt, 'x');
    // The owner (oversee) hands it to Ahmed; Nour is not eligible (cannot see it).
    await chat.assign(w.owner.jwt, threadId, w.ahmed.userId);
    await expect(chat.assign(w.owner.jwt, threadId, w.nour.userId)).rejects.toMatchObject({
      response: { code: 'ASSIGNEE_NOT_ELIGIBLE' },
    });
    // Ahmed may pass on his own; once it is the owner's he may not take it back or resolve it.
    await chat.assign(w.ahmed.jwt, threadId, w.owner.userId);
    await expect(chat.assign(w.ahmed.jwt, threadId, w.ahmed.userId)).rejects.toMatchObject({
      response: { code: 'CANNOT_ASSIGN' },
    });
    await expect(chat.resolve(w.ahmed.jwt, threadId, true)).rejects.toMatchObject({
      response: { code: 'CANNOT_RESOLVE' },
    });
    await chat.resolve(w.owner.jwt, threadId, true);
    // Nobody outside the conversation claims, assigns or resolves it.
    await expect(chat.claim(w.nour.jwt, threadId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(chat.resolve(w.karim.jwt, threadId, false)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // A TEAM conversation cannot be cleared by one staff member for everyone.
    await expect(chat.clearThread(w.ahmed.jwt, threadId)).rejects.toMatchObject({
      response: { code: 'TEAM_CLEAR' },
    });
  });

  it('losing the course loses the TEAM conversation on the next request (stale URL)', async () => {
    if (!guard()) return;
    const w = await world();
    const { threadId } = await toTeam(w, w.sara.jwt, 'x');
    await chat.claim(w.ahmed.jwt, threadId);
    await prisma.membershipCourse.deleteMany({ where: { membershipId: w.ahmed.membershipId } });
    expect(await chat.canAccessThread(w.ahmed.jwt, threadId)).toBe(false);
    await expect(chat.getMessages(w.ahmed.jwt, threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      chat.sendMessage(w.ahmed.jwt, { threadId, body: 'still?' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await chat.listThreads(w.ahmed.jwt)).toHaveLength(0);
    await expect(chat.context(w.ahmed.jwt, threadId)).rejects.toBeInstanceOf(ForbiddenException);
    // …and the capability, likewise.
    const x = await world();
    const t2 = await toTeam(x, x.sara.jwt, 'y');
    await prisma.academyMembership.update({
      where: { id: x.ahmed.membershipId },
      data: { permissions: ['student.view', 'message.reply'] },
    });
    expect(await chat.canAccessThread(x.ahmed.jwt, t2.threadId)).toBe(false);
  });

  it('staff context shows only in-scope courses and never the wallet', async () => {
    if (!guard()) return;
    const w = await world();
    await prisma.enrollment.create({
      data: {
        studentId: w.sara.studentId,
        courseId: w.chemistry.id,
        tenantId: w.chemistry.tenantId,
        academyId: w.academyId,
        status: 'ACTIVE',
      },
    });
    const { threadId } = await toTeam(w, w.sara.jwt, 'x');
    const ctx = await chat.context(w.ahmed.jwt, threadId);
    expect(ctx.courses.map((c) => c.id)).toEqual([w.physics.id]);
    expect(ctx.can).toEqual({ claim: true, assign: false, resolve: true });
    expect(JSON.stringify(ctx)).not.toMatch(/wallet|balance/i);
    const full = await chat.context(w.owner.jwt, threadId);
    expect(full.courses.map((c) => c.id).sort()).toEqual([w.physics.id, w.chemistry.id].sort());
    expect(full.can.assign).toBe(true);
  });

  it('student contact choices: teacher, reachable assistant, and the support team', async () => {
    if (!guard()) return;
    const w = await world();
    const c = await chat.contacts(w.sara.jwt);
    expect(c.map((x) => x.kind).sort()).toEqual(['ASSISTANT', 'OWNER', 'TEAM']);
    expect(c.find((x) => x.kind === 'ASSISTANT')!.staffUserId).toBe(w.ahmed.userId);
    // Nour has no directContact; Karim is not Sara's.
    expect(c.some((x) => x.staffUserId === w.nour.userId || x.staffUserId === w.karim.userId)).toBe(
      false,
    );
    // Resolving the team draft creates nothing.
    const r = await chat.resolveTarget(w.sara.jwt, { academyId: w.academyId, team: true });
    expect(r).toMatchObject({ threadId: null, kind: 'TEAM' });
    expect(await prisma.chatThread.count({ where: { studentId: w.sara.studentId } })).toBe(0);
    // Not an academy she does not study with.
    await expect(
      chat.sendMessage(w.sara.jwt, {
        academyId: w.otherOwner.academyId,
        team: true,
        body: 'x',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'NOT_ENROLLED' } });
  });
});

describe('guardians', () => {
  it('link → sign in → only that child, only that academy, read-only', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    expect(g.jwt.role).toBe('GUARDIAN');
    const kids = await guardians.children(g.jwt);
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      student: { id: w.sara.studentId },
      academy: { id: w.academyId },
    });
    const o = await guardians.overview(g.jwt, kids[0].linkId);
    expect(o.courses.map((c) => c.course.id)).toEqual([w.physics.id]);
    expect(JSON.stringify(o)).not.toMatch(/wallet|balance|amountCents/i);
    // Another link id — someone else's child — is a 404.
    const other = await linkGuardian(w, w.laila.studentId);
    await expect(guardians.overview(g.jwt, other.link.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses tampered, rotated, expired and revoked links; revocation ends the session', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    const bad = g.token.slice(0, -2) + (g.token.endsWith('AA') ? 'BB' : 'AA');
    await expect(guardians.consume(bad, {})).rejects.toBeInstanceOf(GoneException);
    const rotated = await guardians.rotate(await scopeOf(w.ahmed.jwt, w.academyId), g.link.id);
    await expect(guardians.consume(g.token, {})).rejects.toBeInstanceOf(GoneException);
    await expect(guardians.consume(rotated.token, {})).resolves.toBeTruthy();
    await prisma.guardianAccessToken.updateMany({
      where: { linkId: g.link.id, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(guardians.consume(rotated.token, {})).rejects.toBeInstanceOf(GoneException);

    const h = await linkGuardian(w, w.laila.studentId);
    const team = await toTeam(w, h.jwt, 'from the father', { studentId: w.laila.studentId });
    await guardians.revoke(await scopeOf(w.ahmed.jwt, w.academyId), h.link.id);
    expect(await guardians.children(h.jwt)).toHaveLength(0);
    expect(await chat.canAccessThread(h.jwt, team.threadId)).toBe(false);
    // Their last link: every session ends — the next request is refused by the guard.
    const s = await prisma.deviceSession.findUniqueOrThrow({ where: { id: h.jwt.sessionId } });
    expect(s.revokedAt).not.toBeNull();
    await expect(guardians.consume(h.token, {})).rejects.toBeInstanceOf(GoneException);
  });

  it('one guardian, two children; one child, two guardians; the phone decides who, links decide what', async () => {
    if (!guard()) return;
    const w = await world();
    const ph = phone();
    const a = await linkGuardian(w, w.sara.studentId, ph);
    const b = await linkGuardian(w, w.laila.studentId, ph);
    expect(b.session.user.id).toBe(a.session.user.id);
    expect((await guardians.children(a.jwt)).map((c) => c.student.id).sort()).toEqual(
      [w.sara.studentId, w.laila.studentId].sort(),
    );
    const mother = await linkGuardian(w, w.sara.studentId, phone(), 'Mother');
    expect(mother.session.user.id).not.toBe(a.session.user.id);
    expect(
      await prisma.guardianLink.count({ where: { studentId: w.sara.studentId, status: 'ACTIVE' } }),
    ).toBe(2);
    // Revoking one child leaves the other.
    await guardians.revoke(await scopeOf(w.ahmed.jwt, w.academyId), a.link.id);
    expect((await guardians.children(a.jwt)).map((c) => c.student.id)).toEqual([w.laila.studentId]);
  });

  it('cross-academy and existing-account isolation', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    // Not a child of this guardian, in another academy.
    await expect(
      chat.sendMessage(g.jwt, {
        academyId: w.otherOwner.academyId,
        studentId: w.zein.studentId,
        team: true,
        body: 'x',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'NOT_LINKED' } });
    // Nor Sara's in an academy where no link exists.
    await expect(
      chat.sendMessage(g.jwt, {
        academyId: w.otherOwner.academyId,
        studentId: w.sara.studentId,
        team: true,
        body: 'x',
      } as any),
    ).rejects.toMatchObject({ response: { code: 'NOT_LINKED' } });
    // Ahmed cannot add guardians to a student outside his courses.
    await expect(
      guardians.add(await scopeOf(w.ahmed.jwt, w.academyId), w.omar.studentId, {
        name: 'X',
        phone: phone(),
        relationship: 'FATHER',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A phone that already belongs to a student account is refused (V1: one role per account).
    await expect(
      guardians.add(await scopeOf(w.ahmed.jwt, w.academyId), w.sara.studentId, {
        name: 'X',
        phone: w.laila.phone,
        relationship: 'MOTHER',
      }),
    ).rejects.toMatchObject({ response: { code: 'PHONE_IN_USE' } });
  });

  it('a guardian token is refused on every route not marked for guardians', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    const guardAuth = new JwtAuthGuard(jwt, new Reflector(), prisma);
    const ctx = (handler: any) =>
      ({
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization: `Bearer ${g.session.accessToken}` } }),
        }),
      }) as unknown as ExecutionContext;
    const walletRoute = () => undefined;
    await expect(guardAuth.canActivate(ctx(walletRoute))).rejects.toMatchObject({
      response: { code: 'GUARDIAN_SCOPE' },
    });
    const allowed = () => undefined;
    Reflect.defineMetadata(GUARDIAN_ALLOWED_KEY, true, allowed);
    await expect(guardAuth.canActivate(ctx(allowed))).resolves.toBe(true);
  });
});

describe('guardian messaging', () => {
  it('the guardian TEAM conversation is separate from the student’s, and identities stay true', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    const s = await toTeam(w, w.sara.jwt, 'student here');
    const gt = await toTeam(w, g.jwt, 'father here', { studentId: w.sara.studentId });
    expect(gt.threadId).not.toBe(s.threadId);
    expect(gt.message.sender).toMatchObject({ kind: 'GUARDIAN', title: 'FATHER' });
    const t = await prisma.chatThread.findUniqueOrThrow({ where: { id: gt.threadId } });
    expect(t.dedupeKey).toBe(`${w.academyId}|${w.sara.studentId}|G:${g.session.user.id}|TEAM`);
    // Neither side reads the other's.
    expect(await chat.canAccessThread(w.sara.jwt, gt.threadId)).toBe(false);
    expect(await chat.canAccessThread(g.jwt, s.threadId)).toBe(false);
    expect((await chat.listThreads(w.sara.jwt)).map((x) => x.id)).toEqual([s.threadId]);
    expect((await chat.listThreads(g.jwt)).map((x) => x.id)).toEqual([gt.threadId]);
    // Staff handle both in the same inbox, told which is which.
    const inbox = await chat.listThreads(w.ahmed.jwt, { filter: 'unassigned' });
    const gRow = inbox.find((x) => x.id === gt.threadId)!;
    expect(gRow).toMatchObject({ learnerKind: 'GUARDIAN', guardianRelationship: 'FATHER' });
    expect(gRow.studentName).toContain('sara');
    const reply = await chat.sendMessage(w.ahmed.jwt, { threadId: gt.threadId, body: 'hello sir' });
    expect(reply.message.sender?.kind).toBe('ASSISTANT');
    // Reactions, replies and deletion work in a guardian conversation as anywhere.
    await reactions.react(g.jwt, reply.message.id, '👍');
    const answer = await chat.sendMessage(g.jwt, {
      threadId: gt.threadId,
      body: 'thanks',
      replyToId: reply.message.id,
    });
    expect(answer.message.replyTo).toMatchObject({ id: reply.message.id });
    await chat.revokeMessage(g.jwt, answer.message.id);
    await expect(chat.revokeMessage(g.jwt, reply.message.id)).rejects.toMatchObject({
      response: { code: 'NOT_SENDER' },
    });
    // A guardian cannot quote into the student's conversation.
    const cross = await chat.sendMessage(g.jwt, {
      threadId: gt.threadId,
      body: 'q',
      replyToId: s.message.id,
    });
    expect(cross.message.replyTo).toBeNull();
  });

  it('guardian contacts are per child: teacher, reachable assistant, support team', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    const c = await chat.contacts(g.jwt);
    expect(c.map((x) => x.kind).sort()).toEqual(['ASSISTANT', 'OWNER', 'TEAM']);
    expect(c.every((x: any) => x.studentId === w.sara.studentId)).toBe(true);
    const direct = await chat.sendMessage(g.jwt, {
      academyId: w.academyId,
      studentId: w.sara.studentId,
      tenantId: w.physics.tenantId,
      body: 'to the teacher',
    });
    const t = await prisma.chatThread.findUniqueOrThrow({ where: { id: direct.threadId } });
    expect(t).toMatchObject({
      kind: 'DIRECT',
      guardianUserId: g.session.user.id,
      staffUserId: w.owner.userId,
    });
    expect(await chat.canAccessThread(w.owner.jwt, direct.threadId)).toBe(true);
    // directContact is still the rule for assistants.
    await expect(
      chat.sendMessage(g.jwt, {
        academyId: w.academyId,
        studentId: w.sara.studentId,
        staffUserId: w.nour.userId,
        body: 'x',
      }),
    ).rejects.toMatchObject({ response: { code: 'ASSISTANT_NOT_REACHABLE' } });
  });
});

describe('Student 360', () => {
  const staffSvc = () => new StaffService(prisma, scopes, new ConversationPolicy(prisma, scopes));
  it('owner sees the academy slice; a course-limited assistant only theirs; never the wallet', async () => {
    if (!guard()) return;
    const w = await world();
    await prisma.enrollment.create({
      data: {
        studentId: w.sara.studentId,
        courseId: w.chemistry.id,
        tenantId: w.chemistry.tenantId,
        academyId: w.academyId,
        status: 'ACTIVE',
      },
    });
    const g1 = await prisma.group.create({ data: { academyId: w.academyId, name: `A ${w.k}` } });
    const g2 = await prisma.group.create({ data: { academyId: w.academyId, name: `B ${w.k}` } });
    for (const g of [g1, g2]) {
      await prisma.groupMembership.create({
        data: { groupId: g.id, studentId: w.sara.studentId, academyId: w.academyId },
      });
    }
    await prisma.groupAssignment.create({
      data: { groupId: g1.id, userId: w.ahmed.userId, role: 'ASSISTANT', academyId: w.academyId },
    });
    await toTeam(w, w.sara.jwt, 'help');
    const ownerScope = await scopeOf(w.owner.jwt, w.academyId);
    const ahmedScope = await scopeOf(w.ahmed.jwt, w.academyId);
    const o = await staffSvc().student(ownerScope, w.sara.studentId);
    const a = await staffSvc().student(ahmedScope, w.sara.studentId);
    expect(o.courses.map((c) => c.id).sort()).toEqual([w.physics.id, w.chemistry.id].sort());
    expect(a.courses.map((c) => c.id)).toEqual([w.physics.id]);
    const oc = await staffSvc().care(ownerScope, w.owner.jwt, w.sara.studentId);
    const ac = await staffSvc().care(ahmedScope, w.ahmed.jwt, w.sara.studentId);
    expect(oc.groups.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
    expect(ac.groups.map((g) => g.id)).toEqual([g1.id]);
    // The TEAM conversation is in both: Ahmed has inbox + Physics.
    expect(ac.conversations.some((c) => c.kind === 'TEAM')).toBe(true);
    for (const x of [o, a, oc, ac, await staffSvc().progress(ahmedScope, w.sara.studentId)]) {
      expect(JSON.stringify(x)).not.toMatch(/wallet|balance/i);
    }
    // Omar (Chemistry only) is not Ahmed's to open at all.
    await expect(staffSvc().care(ahmedScope, w.ahmed.jwt, w.omar.studentId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(staffSvc().student(ahmedScope, w.omar.studentId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('guardian controls need guardian.manage; payments need payment.view', async () => {
    if (!guard()) return;
    const w = await world();
    const run = async (u: JwtPayload, controller: any, method: string) => {
      const req: any = { user: u, headers: { 'x-academy-id': w.academyId }, params: {} };
      const exec: any = {
        getHandler: () => controller.prototype[method],
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => req }),
      };
      await new AcademyMembershipGuard(academy).canActivate(exec);
      return new PermissionGuard(new Reflector()).canActivate(exec);
    };
    await expect(run(w.nour.jwt, GuardianStaffController, 'add')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(run(w.ahmed.jwt, GuardianStaffController, 'add')).resolves.toBe(true);
    const { StaffController } = await import('../staff/staff.controller');
    await expect(run(w.ahmed.jwt, StaffController, 'payments')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(run(w.owner.jwt, StaffController, 'payments')).resolves.toBe(true);
  });

  it('guardian tokens are stored only as hashes', async () => {
    if (!guard()) return;
    const w = await world();
    const g = await linkGuardian(w, w.sara.studentId);
    const rows = await prisma.guardianAccessToken.findMany({ where: { linkId: g.link.id } });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(g.token);
  });
});

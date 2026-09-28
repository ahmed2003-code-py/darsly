import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyService } from '../academy/academy.service';
import { StaffScopeService } from '../academy/staff-scope.service';
import { AcademyOpsAccessService } from '../academy-ops/academy-ops-access.service';
import { GroupsService } from '../academy-ops/groups.service';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatReactionsService } from './chat-reactions.service';
import { ChatService } from './chat.service';
import { ConversationPolicy } from './conversation-policy';
import { GroupChatService } from './group-chat.service';

/**
 * GROUP chats against a real PostgreSQL. The Group — its members and its
 * assigned staff — is the only source of truth; every "cannot" is asked the
 * way a removed student or an out-of-scope assistant would ask it.
 *
 * The world: an academy (owner Mona) with a group "Physics · Group A".
 * Sara and Laila are in it; Omar studies in the academy but is not. Ahmed is
 * an assistant assigned to the group with message.group; Nour is assigned
 * but lacks message.group; Karim has message.group but is not assigned.
 */
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef';
const prisma = new PrismaService();
let ready = false;
const academy = new AcademyService(prisma);
const scopes = new StaffScopeService(prisma, academy);
const policy = new ConversationPolicy(prisma, scopes);
const events: { userId: string; event: string; payload: any }[] = [];
const realtime = {
  emitToUser: (userId: string, event: string, payload: any) =>
    events.push({ userId, event, payload }),
  emitToThread: () => undefined,
} as any;
const notified: { userId: string; threadId: string; title: string }[] = [];
const notifications = {
  create: async () => ({}),
  upsertForThread: async (n: any) => {
    notified.push(n);
    return {};
  },
} as any;
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
    const o = objects.get(key)!;
    return { stream: Readable.from(o), contentLength: o.length, totalSize: o.length };
  },
  async delete(key: string) {
    objects.delete(key);
  },
} as any;
const chat = new ChatService(prisma, realtime, notifications, storage, scopes, policy);
const files = new ChatAttachmentsService(prisma, storage, chat);
const reactions = new ChatReactionsService(prisma, chat, realtime);
const opsAccess = new AcademyOpsAccessService(prisma);
const groups = new GroupsService(prisma, opsAccess, { log: async () => undefined } as any);
const groupChat = new GroupChatService(prisma, opsAccess, policy, realtime);

beforeAll(async () => {
  await prisma.onModuleInit().catch(() => undefined);
  ready = await databaseReady(prisma, [
    'chatThread',
    'group',
    'groupMembership',
    'membershipCourse',
  ]);
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => ready;
const as = (sub: string, role: Role, tenantId?: string) =>
  ({ sub, role, tenantId, sessionId: 's' }) as JwtPayload;
const ctxOf = async (u: JwtPayload, academyId: string) =>
  (await academy.buildContext(u.sub, academyId, u.role))!;

async function world() {
  const k = randomUUID().slice(0, 8);
  const tUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Mona ${k}`, email: `gc-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: tUser.id, slug: `gc-t-${k}`, status: 'APPROVED', acceptsStudentMessages: true },
  });
  await prisma.academy.create({
    data: { id: tp.id, slug: `gc-a-${k}`, name: `Academy ${k}`, ownerUserId: tUser.id },
  });
  await prisma.academyMembership.create({
    data: { userId: tUser.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const course = await prisma.course.create({
    data: { tenantId: tp.id, academyId: tp.id, title: `Physics ${k}`, status: 'PUBLISHED' },
  });
  const student = async (name: string) => {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `${name} ${k}`, email: `gc-${name}-${k}@it.test` },
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
    return { userId: u.id, studentId: sp.id, jwt: as(u.id, Role.STUDENT) };
  };
  const sara = await student('sara');
  const laila = await student('laila');
  const omar = await student('omar');
  const group = await prisma.group.create({
    data: { academyId: tp.id, name: `Physics · Group A ${k}` },
  });
  const owner = { userId: tUser.id, jwt: as(tUser.id, Role.TEACHER, tp.id) };
  await groups.addMembers(await ctxOf(owner.jwt, tp.id), group.id, {
    studentIds: [sara.studentId, laila.studentId],
  });
  const assistant = async (name: string, permissions: string[], assigned: boolean) => {
    const u = await prisma.user.create({
      data: { role: 'STAFF', fullName: `${name} ${k}`, email: `gc-${name}-${k}@it.test` },
    });
    const m = await prisma.academyMembership.create({
      data: {
        userId: u.id,
        academyId: tp.id,
        role: 'ASSISTANT',
        status: 'ACTIVE',
        title: 'Student Support',
        permissions,
      },
    });
    if (assigned) {
      await prisma.groupAssignment.create({
        data: { groupId: group.id, userId: u.id, role: 'ASSISTANT', academyId: tp.id },
      });
    }
    return { userId: u.id, membershipId: m.id, jwt: as(u.id, Role.STAFF) };
  };
  const ahmed = await assistant('ahmed', ['message.group', 'group.manage'], true);
  const nour = await assistant('nour', ['message.reply'], true);
  const karim = await assistant('karim', ['message.group'], false);
  const on = await groupChat.enable(await ctxOf(owner.jwt, tp.id), group.id);
  return {
    k,
    academyId: tp.id,
    course,
    group,
    owner,
    sara,
    laila,
    omar,
    ahmed,
    nour,
    karim,
    threadId: on.threadId!,
  };
}
type World = Awaited<ReturnType<typeof world>>;
const say = (w: World, from: JwtPayload, body: string, extra: object = {}) =>
  chat.sendMessage(from, { threadId: w.threadId, body, ...extra });
const staged = async (name: string, bytes: Buffer) => {
  const p = path.join(os.tmpdir(), `gc-${randomUUID()}`);
  await fsp.writeFile(p, bytes);
  return { path: p, originalname: name, size: bytes.length };
};
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(1500, 7)]);

describe('group chat — one canonical conversation per existing Group', () => {
  it('enabling is idempotent, even concurrently; the group keeps its own membership', async () => {
    if (!guard()) return;
    const w = await world();
    const ctx = await ctxOf(w.owner.jwt, w.academyId);
    const again = await Promise.all([
      groupChat.enable(ctx, w.group.id),
      groupChat.enable(ctx, w.group.id),
    ]);
    expect(again.map((a) => a.threadId)).toEqual([w.threadId, w.threadId]);
    expect(await prisma.chatThread.count({ where: { groupId: w.group.id } })).toBe(1);
    const t = await prisma.chatThread.findUniqueOrThrow({ where: { id: w.threadId } });
    expect(t).toMatchObject({
      kind: 'GROUP',
      studentId: null,
      tenantId: null,
      staffUserId: null,
      groupMode: 'OPEN',
    });
    expect(t.dedupeKey).toBe(`${w.academyId}|GROUP:${w.group.id}`);
    // A second row for the same group is refused by the database itself.
    await expect(
      prisma.chatThread.create({
        data: { kind: 'GROUP', groupId: w.group.id, academyId: w.academyId, dedupeKey: `x-${w.k}` },
      }),
    ).rejects.toThrow();
  });

  it('who is in: active students and entitled staff — no one else', async () => {
    if (!guard()) return;
    const w = await world();
    for (const u of [w.sara, w.laila, w.owner, w.ahmed])
      expect(await chat.canAccessThread(u.jwt, w.threadId)).toBe(true);
    for (const u of [w.omar, w.nour, w.karim])
      expect(await chat.canAccessThread(u.jwt, w.threadId)).toBe(false);
    expect((await policy.recipients((await policy.parties(w.threadId))!)).sort()).toEqual(
      [w.sara.userId, w.laila.userId, w.owner.userId, w.ahmed.userId].sort(),
    );
    // Students see it in their list — before anyone has written.
    expect((await chat.listThreads(w.sara.jwt)).map((t) => t.id)).toContain(w.threadId);
    expect((await chat.listThreads(w.omar.jwt)).map((t) => t.id)).not.toContain(w.threadId);
    expect((await chat.listThreads(w.ahmed.jwt)).map((t) => t.id)).toContain(w.threadId);
    expect((await chat.listThreads(w.karim.jwt)).map((t) => t.id)).not.toContain(w.threadId);
    const [row] = (await chat.listThreads(w.sara.jwt)).filter((t) => t.id === w.threadId);
    expect(row).toMatchObject({
      kind: 'GROUP',
      groupName: w.group.name,
      memberCount: 2,
      groupMode: 'OPEN',
    });
  });

  it('messages keep the real sender; everyone else is notified with the group and the sender', async () => {
    if (!guard()) return;
    const w = await world();
    notified.length = 0;
    const a = await say(w, w.owner.jwt, 'السلام عليكم يا شباب، الحصة الجاية يوم الخميس');
    expect(a.message.sender?.kind).toBe('OWNER');
    const b = await say(w, w.ahmed.jwt, 'reminder');
    expect(b.message.sender).toMatchObject({ kind: 'ASSISTANT', title: 'Student Support' });
    const c = await say(w, w.sara.jwt, 'تمام');
    expect(c.message.sender?.kind).toBe('STUDENT');
    const forA = notified.filter((n) => n.title.includes(w.group.name));
    expect(forA.length).toBeGreaterThan(0);
    expect(notified.every((n) => n.userId !== w.omar.userId && n.userId !== w.nour.userId)).toBe(
      true,
    );
    expect(notified.filter((n) => n.userId === w.sara.userId).length).toBe(2); // not for her own
  });

  it('announcements: students read, staff write; students cannot change the mode', async () => {
    if (!guard()) return;
    const w = await world();
    await expect(
      groupChat.setModeFromChat(w.sara.jwt, w.threadId, 'ANNOUNCEMENTS'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await groupChat.setModeFromChat(w.ahmed.jwt, w.threadId, 'ANNOUNCEMENTS');
    await expect(say(w, w.sara.jwt, 'can I?')).rejects.toMatchObject({
      response: { code: 'READ_ONLY' },
    });
    await expect(
      files.upload(w.sara.jwt, await staged('x.pdf', pdf()), { threadId: w.threadId }),
    ).rejects.toMatchObject({
      response: { code: 'READ_ONLY' },
    });
    await expect(say(w, w.owner.jwt, 'Exam on Thursday')).resolves.toBeTruthy();
    // Reading and reacting are still fine.
    const msgs = await chat.getMessages(w.sara.jwt, w.threadId);
    await reactions.react(w.sara.jwt, msgs[msgs.length - 1].id, '👍');
    const info = await groupChat.info(w.sara.jwt, w.threadId);
    expect(info).toMatchObject({
      mode: 'ANNOUNCEMENTS',
      can: { send: false, manage: false },
      students: null,
    });
    await groupChat.setModeFromChat(w.owner.jwt, w.threadId, 'OPEN');
    await expect(say(w, w.sara.jwt, 'thanks')).resolves.toBeTruthy();
    const staffInfo = await groupChat.info(w.owner.jwt, w.threadId);
    expect(staffInfo.students?.length).toBe(2);
    expect(staffInfo.can.manage).toBe(true);
  });

  it('a student added later reads from when they joined — not before', async () => {
    if (!guard()) return;
    const w = await world();
    const before = await say(w, w.owner.jwt, 'before Omar');
    await new Promise((r) => setTimeout(r, 20));
    await groups.addMembers(await ctxOf(w.owner.jwt, w.academyId), w.group.id, {
      studentIds: [w.omar.studentId],
    });
    const after = await say(w, w.owner.jwt, 'after Omar');
    // Unread counts only what is his: "after Omar", not "before Omar".
    const [fresh] = (await chat.listThreads(w.omar.jwt)).filter((t) => t.id === w.threadId);
    expect(fresh.unread).toBe(1);
    const seen = await chat.getMessages(w.omar.jwt, w.threadId);
    expect(seen.map((m) => m.id)).toEqual([after.message.id]);
    // Not around a cursor, not through a quote, not by reacting to it.
    const around = await chat
      .getMessages(w.omar.jwt, w.threadId, { around: before.message.id })
      .catch((e) => e);
    expect(around).toBeInstanceOf(BadRequestException);
    const quoted = await say(w, w.sara.jwt, 'quoting old', { replyToId: before.message.id });
    const omarView = (await chat.getMessages(w.omar.jwt, w.threadId)).find(
      (m) => m.id === quoted.message.id,
    )!;
    expect(omarView.replyTo).toMatchObject({ unavailable: true, body: '' });
    await expect(reactions.react(w.omar.jwt, before.message.id, '👍')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const reply = await say(w, w.omar.jwt, 'reply to old', { replyToId: before.message.id });
    expect(reply.message.replyTo).toBeNull();
  });

  it('a removed student loses everything on the next request, and a re-added one starts over', async () => {
    if (!guard()) return;
    const w = await world();
    const up = await files.upload(w.owner.jwt, await staged('notes.pdf', pdf()), {
      threadId: w.threadId,
    });
    const m = await say(w, w.owner.jwt, 'file', { attachmentIds: [up.id] });
    await groups.removeMember(await ctxOf(w.owner.jwt, w.academyId), w.group.id, w.laila.studentId);
    expect(await chat.canAccessThread(w.laila.jwt, w.threadId)).toBe(false);
    await expect(chat.getMessages(w.laila.jwt, w.threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(say(w, w.laila.jwt, 'still here?')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(reactions.react(w.laila.jwt, m.message.id, '👍')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(chat.hideMessage(w.laila.jwt, m.message.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      files.upload(w.laila.jwt, await staged('x.pdf', pdf()), { threadId: w.threadId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await chat.listThreads(w.laila.jwt)).map((t) => t.id)).not.toContain(w.threadId);
    // She is no longer a recipient: no realtime events, no notifications.
    events.length = 0;
    notified.length = 0;
    await say(w, w.owner.jwt, 'after she left');
    expect(events.some((e) => e.userId === w.laila.userId)).toBe(false);
    expect(notified.some((n) => n.userId === w.laila.userId)).toBe(false);
    // Added back: a new membership — nothing from before, including her own stint.
    await new Promise((r) => setTimeout(r, 20));
    await groups.addMembers(await ctxOf(w.owner.jwt, w.academyId), w.group.id, {
      studentIds: [w.laila.studentId],
    });
    const back = await chat.getMessages(w.laila.jwt, w.threadId);
    expect(back).toHaveLength(0);
    const sara = await prisma.groupMembership.findFirstOrThrow({
      where: { groupId: w.group.id, studentId: w.sara.studentId },
    });
    expect(sara.deletedAt).toBeNull(); // active members untouched by a re-add
  });

  it('staff: capability AND the group’s own scope; losing either closes it', async () => {
    if (!guard()) return;
    const w = await world();
    await expect(say(w, w.nour.jwt, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(say(w, w.karim.jwt, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(groupChat.info(w.karim.jwt, w.threadId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await prisma.groupAssignment.deleteMany({
      where: { groupId: w.group.id, userId: w.ahmed.userId },
    });
    expect(await chat.canAccessThread(w.ahmed.jwt, w.threadId)).toBe(false);
    const x = await world();
    await prisma.academyMembership.update({
      where: { id: x.ahmed.membershipId },
      data: { permissions: ['group.manage'] },
    });
    expect(await chat.canAccessThread(x.ahmed.jwt, x.threadId)).toBe(false);
  });

  it('switching the chat off closes it to students, keeps the group, and switching on restores it', async () => {
    if (!guard()) return;
    const w = await world();
    await say(w, w.sara.jwt, 'hi');
    const ctx = await ctxOf(w.owner.jwt, w.academyId);
    await groupChat.update(ctx, w.group.id, { enabled: false });
    expect(await chat.canAccessThread(w.sara.jwt, w.threadId)).toBe(false);
    await expect(say(w, w.owner.jwt, 'x')).rejects.toMatchObject({
      response: { code: 'READ_ONLY' },
    });
    expect(await prisma.group.count({ where: { id: w.group.id } })).toBe(1);
    const on = await groupChat.update(ctx, w.group.id, { enabled: true });
    expect(on.threadId).toBe(w.threadId);
    expect((await chat.getMessages(w.sara.jwt, w.threadId)).map((m) => m.body)).toEqual(['hi']);
    // A student cannot manage the chat at all.
    await expect(
      groupChat.enable(await ctxOf(w.sara.jwt, w.academyId).catch(() => null as any), w.group.id),
    ).rejects.toBeTruthy();
    // A teacher without the group in scope cannot manage it either.
    await expect(
      groupChat.update(await ctxOf(w.karim.jwt, w.academyId), w.group.id, {
        mode: 'ANNOUNCEMENTS',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delete for everyone stays the sender’s; reads show a count, not faces; voice + file is one message', async () => {
    if (!guard()) return;
    const w = await world();
    const a = await say(w, w.sara.jwt, 'mine');
    await expect(chat.revokeMessage(w.laila.jwt, a.message.id)).rejects.toMatchObject({
      response: { code: 'NOT_SENDER' },
    });
    await expect(chat.revokeMessage(w.owner.jwt, a.message.id)).rejects.toMatchObject({
      response: { code: 'NOT_SENDER' },
    });
    await chat.markThreadRead(w.laila.jwt, w.threadId);
    await chat.markThreadRead(w.owner.jwt, w.threadId);
    const mine = (await chat.getMessages(w.sara.jwt, w.threadId)).find(
      (m) => m.id === a.message.id,
    )!;
    expect(mine.seenCount).toBe(2);
    const others = (await chat.getMessages(w.laila.jwt, w.threadId)).find(
      (m) => m.id === a.message.id,
    )!;
    expect(others.seenCount).toBeUndefined();
    const v = await files.upload(
      w.sara.jwt,
      await staged('voice.webm', webm()),
      { threadId: w.threadId },
      { durationSec: 4 },
    );
    const f = await files.upload(w.sara.jwt, await staged('hw.pdf', pdf()), {
      threadId: w.threadId,
    });
    const combo = await say(w, w.sara.jwt, '', { attachmentIds: [v.id, f.id] });
    expect(combo.message.attachments!.map((x) => x.kind).sort()).toEqual(['FILE', 'VOICE']);
    await chat.revokeMessage(w.sara.jwt, a.message.id);
    // Guardians are not in class chats in V1; nor is a group chat reachable as a DIRECT target.
    await expect(chat.clearThread(w.sara.jwt, w.threadId)).rejects.toMatchObject({
      response: { code: 'GROUP_CLEAR' },
    });
    await expect(chat.context(w.owner.jwt, w.threadId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('another academy’s owner and a random account see nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const x = await world();
    expect(await chat.canAccessThread(x.owner.jwt, w.threadId)).toBe(false);
    await expect(
      groupChat.status(await ctxOf(x.owner.jwt, x.academyId), w.group.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

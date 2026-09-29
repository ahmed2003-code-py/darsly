import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { PRESENCE_GRACE_SEC, TRANSCRIPT_PREVIEW_SEGMENTS } from './live.service';
import { classroom, classroomWorld, codeOf, confirmedGuest } from './testing/classroom';

/**
 * Live V1 Phase A on a real PostgreSQL: what a finished class leaves behind —
 * the chat archive (every message, a page at a time, names as they were),
 * attendance that says only what was recorded, and a transcript the archive
 * previews before loading it whole.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveChatMessage', 'liveAttendance']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

describe('the chat archive', () => {
  it('a 250-message class: the newest page first, then every older message — none lost', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    const base = Date.now() - 30 * MIN;
    // Two messages share every timestamp: the cursor must break ties by id.
    await prisma.liveChatMessage.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        sessionId: w.ls.id,
        userId: i % 2 ? w.s[0].id : w.teacher.id,
        body: `m${i}`,
        createdAt: new Date(base + Math.floor(i / 2) * 1000),
      })),
    });
    const first = await live.chatHistory(w.s[1].id, w.ls.id);
    expect(first).toHaveLength(200);
    const seen = new Set(first.map((m) => m.body));
    let before = first[0].id;
    for (;;) {
      const page = await live.chatHistory(w.s[1].id, w.ls.id, { before, limit: 60 });
      if (!page.length) break;
      for (const m of page) {
        expect(seen.has(m.body)).toBe(false);
        seen.add(m.body);
      }
      before = page[0].id;
    }
    expect(seen.size).toBe(250);
    // The newest page ends with the last message, oldest first within the page.
    const bodies = first.map((m) => m.createdAt.getTime());
    expect([...bodies].sort((a, b) => a - b)).toEqual(bodies);
  });

  it("a cursor from another class is refused; an outsider cannot read at all", async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const other = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    const m = await live.sendChat(other.teacher.id, other.ls.id, 'x');
    expect(await codeOf(live.chatHistory(w.s[0].id, w.ls.id, { before: m.id }))).toBe('CHAT_CURSOR_INVALID');
    expect(await codeOf(live.chatHistory(w.outsider.id, w.ls.id))).toBe('You are not in this session');
  });

  it('names are kept as they were in the class; messages from before the snapshot read the account', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    const old = await prisma.liveChatMessage.create({ data: { sessionId: w.ls.id, userId: w.s[0].id, body: 'قديمة' } });
    await live.sendChat(w.s[0].id, w.ls.id, 'جديدة');
    const guest = await confirmedGuest(prisma, w, 'ضيفة الحصة');
    await live.sendChat(guest.id, w.ls.id, 'من الضيفة');
    await prisma.user.update({ where: { id: w.s[0].id }, data: { fullName: 'اسم جديد' } });
    const all = await live.chatHistory(w.teacher.id, w.ls.id);
    expect(all.find((m) => m.body === 'جديدة')?.senderName).toBe(w.s[0].fullName);
    expect(all.find((m) => m.id === old.id)?.senderName).toBe('اسم جديد');
    expect(all.find((m) => m.body === 'من الضيفة')?.senderName).toBe('ضيفة الحصة');
  });
});

describe('attendance V2', () => {
  it('expected, joined, absent and percentages from the class as it really ran', async () => {
    if (!guard()) return;
    // Ran 40 of its booked 60 minutes.
    const w = await classroomWorld(prisma, {
      status: 'ENDED',
      startedAt: new Date(Date.now() - 50 * MIN),
      endedAt: new Date(Date.now() - 10 * MIN),
      startsAt: new Date(Date.now() - 50 * MIN),
    });
    const { live } = classroom(prisma);
    const att = (userId: string, role: 'TEACHER' | 'STUDENT', sec: number, extra: Record<string, unknown> = {}) =>
      prisma.liveAttendance.create({
        data: { sessionId: w.ls.id, userId, role, durationSeconds: sec, joinedAt: new Date(Date.now() - 49 * MIN), ...extra },
      });
    await att(w.teacher.id, 'TEACHER', 2400);
    await att(w.s[0].id, 'STUDENT', 2400); // the whole class
    await att(w.s[1].id, 'STUDENT', 300, { reconnects: 2 }); // five minutes, dropped out twice
    // s[2] booked and never came.
    const r = await live.attendanceFor(w.scope, w.ls.id);
    expect(r.summary).toMatchObject({ runSeconds: 2400, expected: 3, joined: 2, absent: 1, attended: 1 });
    expect(r.summary.averagePercent).toBe(Math.round((100 + 13) / 2));
    const a = r.rows.find((x) => x.userId === w.s[0].id)!;
    const b = r.rows.find((x) => x.userId === w.s[1].id)!;
    expect(a).toMatchObject({ percent: 100, status: 'ATTENDED' });
    expect(b).toMatchObject({ percent: 13, status: 'PARTIAL', reconnects: 2 });
    expect(r.absent.map((x) => x.userId)).toEqual([w.s[2].id]);
    // The teacher is listed, never counted as a student.
    expect(r.rows.find((x) => x.userId === w.teacher.id)?.status).toBeNull();
  });

  it('speaking and hands are counted from what the class recorded — microphone tracks, raised hands', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { live, rtc } = classroom(prisma);
    await prisma.liveAttendance.create({ data: { sessionId: w.ls.id, userId: w.s[0].id, role: 'STUDENT', durationSeconds: 60 } });
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await rtc.hand(w.s[0].id, w.ls.id, 'lower');
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    const conn = await prisma.liveRtcConnection.create({
      data: { sessionId: w.ls.id, roomName: w.ls.roomName!, userId: w.s[0].id, role: 'STUDENT', purpose: 'SEND', cfSessionId: `cf-${w.k}` },
    });
    const t0 = Date.now() - 5 * MIN;
    await prisma.liveRtcTrack.createMany({
      data: [
        { connectionId: conn.id, sessionId: w.ls.id, roomName: w.ls.roomName!, userId: w.s[0].id, kind: 'AUDIO', trackName: 'a1', mid: '0', createdAt: new Date(t0), closedAt: new Date(t0 + 30_000) },
        { connectionId: conn.id, sessionId: w.ls.id, roomName: w.ls.roomName!, userId: w.s[0].id, kind: 'AUDIO', trackName: 'a2', mid: '1', createdAt: new Date(t0 + 60_000), closedAt: new Date(t0 + 80_000) },
        // A camera is not speaking.
        { connectionId: conn.id, sessionId: w.ls.id, roomName: w.ls.roomName!, userId: w.s[0].id, kind: 'VIDEO', trackName: 'v1', mid: '2', createdAt: new Date(t0), closedAt: new Date(t0 + 80_000) },
      ],
    });
    const row = (await live.attendanceFor(w.scope, w.ls.id)).rows.find((x) => x.userId === w.s[0].id)!;
    expect(row).toMatchObject({ raisedCount: 2, spokeCount: 2, micOpenSeconds: 50 });
  });

  it('a heartbeat gap longer than the grace is a drop-out: no minutes credited, one reconnect counted', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    await prisma.liveAttendance.create({
      data: { sessionId: w.ls.id, userId: w.s[0].id, role: 'STUDENT', lastSeenAt: new Date(Date.now() - 30_000), durationSeconds: 100 },
    });
    await live.heartbeat(w.s[0].id, w.ls.id);
    let a = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id, userId: w.s[0].id } });
    expect(a.reconnects).toBe(0);
    expect(a.durationSeconds).toBeGreaterThanOrEqual(129);
    await prisma.liveAttendance.update({
      where: { id: a.id },
      data: { lastSeenAt: new Date(Date.now() - (PRESENCE_GRACE_SEC + 60) * 1000) },
    });
    const before = a.durationSeconds;
    await live.heartbeat(w.s[0].id, w.ls.id);
    a = await prisma.liveAttendance.findFirstOrThrow({ where: { id: a.id } });
    expect(a.reconnects).toBe(1);
    expect(a.durationSeconds).toBe(before);
  });

  it('a confirmed guest who never came is listed absent, as a guest', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { accessMode: 'FREE' });
    const { live } = classroom(prisma);
    const g = await confirmedGuest(prisma, w, 'ضيف غائب');
    const r = await live.attendanceFor(w.scope, w.ls.id);
    expect(r.absent.find((x) => x.userId === g.id)).toMatchObject({ fullName: 'ضيف غائب', guest: true });
  });
});

describe('the archive transcript', () => {
  it('the detail carries a preview and a count; the full text comes on its own, under the same rules', async () => {
    if (!guard()) return;
    const segments = Array.from({ length: 12 }, (_, i) => ({ startSec: i * 180, durationSec: 180, text: `جزء ${i}` }));
    const w = await classroomWorld(prisma, {
      status: 'ENDED',
      endedAt: new Date(),
      transcriptStatus: 'READY',
      transcriptText: segments.map((s) => s.text).join('\n\n'),
      transcriptSegments: segments,
      transcriptVisibility: 'STUDENTS',
    });
    const { live } = classroom(prisma);
    const preview: any = await live.sessionDetail(w.teacher.id, w.ls.id, { transcript: 'preview' });
    expect(preview.transcript.segments).toHaveLength(TRANSCRIPT_PREVIEW_SEGMENTS);
    expect(preview.transcript).toMatchObject({ segmentCount: 12, preview: true });
    const full: any = await live.sessionDetail(w.s[0].id, w.ls.id, { transcript: 'full' });
    expect(full.transcript.segments).toHaveLength(12);
    // Private: a student gets nothing, preview or full.
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { transcriptVisibility: 'PRIVATE' } });
    const hidden: any = await live.sessionDetail(w.s[0].id, w.ls.id, { transcript: 'full' });
    expect(hidden.transcript?.segments).toBeUndefined();
  });
});

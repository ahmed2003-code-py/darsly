import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { LiveService } from './live.service';
import { LiveRtcService } from './rtc/live-rtc.service';
import { classroom, classroomWorld, confirmedGuest, enterRoom, OFFER, type ClassroomWorld } from './testing/classroom';
import { finalizeTranscript } from './transcription/transcript-assembly';
import { segmentsFor, verifySpeaker } from './transcription/speakers';

/**
 * Live V1 Phase G on a real PostgreSQL: a transcript that says who spoke —
 * by microphone ownership only. The teacher's page says whose microphone a
 * piece is; the server believes it only when its own track table agrees
 * (that person published an AUDIO track in this run while the piece was
 * recorded). Readers never receive a user id, and a student sees classmates
 * as numbers. The plain transcript text (summary, Exam Studio, Live →
 * Content) carries no labels.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveAudioSegment', 'liveRtcTrack']);
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

type C = ReturnType<typeof classroom>;
/** A student allowed to speak, publishing a microphone. */
async function speak(c: C, w: ClassroomWorld, userId: string) {
  await enterRoom(prisma, c, w, userId);
  await c.rtc.hand(userId, w.ls.id, 'raise');
  await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', userId);
  const { connectionId } = await c.rtc.openConnection(userId, w.ls.id, 'SEND');
  await c.rtc.publish(userId, w.ls.id, connectionId, { offer: OFFER, tracks: [{ mid: '0', kind: 'AUDIO' }] });
}
const verify = (w: ClassroomWorld, claimed: string | undefined, startMs = Date.now(), run = w.ls.roomName!) =>
  verifySpeaker(prisma, {
    sessionId: w.ls.id,
    run,
    teacherUserId: w.teacher.id,
    uploaderUserId: w.teacher.id,
    claimedUserId: claimed,
    startMs,
    durationMs: 20_000,
  });

describe('whose microphone: verified, never taken on trust', () => {
  it('the teacher, a speaking student, a guest — each by their own track', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { accessMode: 'FREE' });
    const c = classroom(prisma);
    await speak(c, w, w.s[0].id);
    const guest = await confirmedGuest(prisma, w, 'ضيف المعرض');
    await speak(c, w, guest.id);
    expect(await verify(w, w.teacher.id)).toEqual({
      speakerUserId: w.teacher.id,
      speakerKind: 'TEACHER',
      speakerName: w.teacher.fullName,
    });
    expect(await verify(w, w.s[0].id)).toEqual({
      speakerUserId: w.s[0].id,
      speakerKind: 'STUDENT',
      speakerName: w.s[0].fullName,
    });
    expect(await verify(w, guest.id)).toMatchObject({ speakerKind: 'GUEST', speakerName: 'ضيف المعرض' });
    // No claim: a mixed piece, no attribution at all.
    expect(await verify(w, undefined)).toEqual({ speakerUserId: null, speakerKind: null, speakerName: null });
  });

  it('a forged claim is UNKNOWN: no microphone, another run, another time, a made-up id', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await speak(c, w, w.s[0].id);
    const unknown = { speakerUserId: null, speakerKind: 'UNKNOWN', speakerName: null };
    // Booked, in the room, but never allowed a microphone.
    await enterRoom(prisma, c, w, w.s[1].id);
    expect(await verify(w, w.s[1].id)).toEqual(unknown);
    // The right student, the wrong run of the class.
    expect(await verify(w, w.s[0].id, Date.now(), `${w.ls.roomName}-old`)).toEqual(unknown);
    // Before their microphone existed.
    expect(await verify(w, w.s[0].id, Date.now() - 10 * MIN)).toEqual(unknown);
    // Someone not in the class at all, and an id that is no one.
    expect(await verify(w, w.outsider.id)).toEqual(unknown);
    expect(await verify(w, 'not-a-user')).toEqual(unknown);
  });

  it('a camera is not a microphone', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { cameraPolicy: 'OPTIONAL' });
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.s[0].id);
    const { connectionId } = await c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    await c.rtc.publish(w.s[0].id, w.ls.id, connectionId, { offer: OFFER, tracks: [{ mid: '0', kind: 'VIDEO' }] });
    expect((await verify(w, w.s[0].id)).speakerKind).toBe('UNKNOWN');
  });

  it('a reconnect: the old microphone covers its own time, the new one the rest', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await speak(c, w, w.s[0].id);
    // The first microphone ended 3 minutes ago; a new one opens now.
    await prisma.liveRtcTrack.updateMany({
      where: { sessionId: w.ls.id, userId: w.s[0].id },
      data: { createdAt: new Date(Date.now() - 8 * MIN), closedAt: new Date(Date.now() - 3 * MIN) },
    });
    expect((await verify(w, w.s[0].id, Date.now() - 6 * MIN)).speakerKind).toBe('STUDENT');
    // Between the two microphones: no track was open.
    expect((await verify(w, w.s[0].id, Date.now() - 2 * MIN)).speakerKind).toBe('UNKNOWN');
    const { connectionId } = await c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    await c.rtc.publish(w.s[0].id, w.ls.id, connectionId, { offer: OFFER, tracks: [{ mid: '1', kind: 'AUDIO' }] });
    expect((await verify(w, w.s[0].id)).speakerKind).toBe('STUDENT');
  });
});

describe('the upload path', () => {
  const env = { ...process.env };
  beforeAll(() => {
    process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'sk-test-never-called';
  });
  afterAll(() => {
    process.env = env;
  });
  const webm = () => {
    const b = Buffer.alloc(4000);
    b.writeUInt32BE(0x1a45dfa3, 0);
    return { buffer: b, size: b.length, mimetype: 'audio/webm;codecs=opus' };
  };

  it("stores the verified speaker; a forged one as UNKNOWN; nothing for a mixed piece", async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { transcriptionMode: 'MANUAL', transcriptCaptureOnAt: new Date() });
    const c = classroom(prisma);
    const stored = new Map<string, Buffer>();
    const live = new LiveService(
      prisma,
      { create: async () => ({}) } as never,
      { recordOrThrow: async () => ({}) } as never,
      (c.live as unknown as { providers: never }).providers,
      c.realtime as never,
      {} as never,
      (c.live as unknown as { academy: never }).academy,
      { put: async (k: string, b: Buffer) => void stored.set(k, b) } as never,
    );
    const rtc = new LiveRtcService(prisma, live, c.cloudflare, c.realtime as never);
    await speak({ ...c, rtc, live }, w, w.s[0].id);
    const t = Math.floor(Date.now() / 1000);
    await live.storeAudioPiece(w.scope, w.ls.id, t, webm(), 20_000, { uploaderUserId: w.teacher.id, speakerUserId: w.s[0].id });
    await live.storeAudioPiece(w.scope, w.ls.id, t + 1, webm(), 20_000, { uploaderUserId: w.teacher.id, speakerUserId: w.s[1].id });
    await live.storeAudioPiece(w.scope, w.ls.id, t + 2, webm(), 20_000, { uploaderUserId: w.teacher.id });
    const rows = await prisma.liveAudioSegment.findMany({ where: { sessionId: w.ls.id }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => [r.speakerKind, r.speakerUserId])).toEqual([
      ['STUDENT', w.s[0].id],
      ['UNKNOWN', null],
      [null, null],
    ]);
    expect(stored.size).toBe(3);
  });
});

describe('the transcript as each reader sees it', () => {
  async function transcribed() {
    const w = await classroomWorld(prisma, { transcriptVisibility: 'STUDENTS' });
    const at = Math.floor(w.ls.startedAt!.getTime() / 1000);
    const piece = (seq: number, ms: number, text: string, who?: { id: string; name: string; kind: string }) => ({
      sessionId: w.ls.id,
      roomName: w.ls.roomName!,
      seq: at + seq,
      key: `k${seq}`,
      sizeBytes: 4000,
      durationMs: ms,
      text,
      speakerUserId: who && who.kind !== 'UNKNOWN' ? who.id : null,
      speakerKind: (who?.kind ?? null) as never,
      speakerName: who && who.kind !== 'UNKNOWN' ? who.name : null,
    });
    const T = { id: w.teacher.id, name: w.teacher.fullName!, kind: 'TEACHER' };
    const A = { id: w.s[0].id, name: w.s[0].fullName!, kind: 'STUDENT' };
    const B = { id: w.s[1].id, name: w.s[1].fullName!, kind: 'STUDENT' };
    await prisma.liveAudioSegment.createMany({
      data: [
        piece(0, 60_000, 'شرح المعادلة', T),
        piece(60, 60_000, 'تكملة الشرح', T),
        piece(125, 10_000, 'الإجابة اتنين', A),
        piece(130, 10_000, 'لا تلاتة', B), // over A: both marked
        piece(150, 8_000, 'كلام غير واضح', { id: '', name: '', kind: 'UNKNOWN' }),
        piece(170, 30_000, 'ممتاز', T),
      ],
    });
    const out = await finalizeTranscript(prisma, {
      sessionId: w.ls.id,
      roomName: w.ls.roomName!,
      jobId: null,
      model: 'gpt-4o-mini-transcribe',
      giveUpPending: false,
    });
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { status: 'ENDED', endedAt: new Date() } });
    return { w, out };
  }

  it('the words stay plain for the summary, Exam Studio and Live → Content', async () => {
    if (!guard()) return;
    const { w, out } = await transcribed();
    expect(out.meta.speakers).toBe(3);
    const s = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(s.transcriptText).toBe(
      ['شرح المعادلة', 'تكملة الشرح', 'الإجابة اتنين', 'لا تلاتة', 'كلام غير واضح', 'ممتاز'].join('\n\n'),
    );
    expect(s.transcriptText).not.toContain(w.s[0].fullName!);
    const segs = s.transcriptSegments as { overlap?: boolean; text: string }[];
    expect(segs.filter((x) => x.overlap).map((x) => x.text)).toEqual(['الإجابة اتنين', 'لا تلاتة']);
  });

  it('the teacher sees names; a student sees «you», the teacher, and «student N» — never an id', async () => {
    if (!guard()) return;
    const { w } = await transcribed();
    const { live } = classroom(prisma);
    const teacher: any = await live.sessionDetail(w.teacher.id, w.ls.id, { transcript: 'full' });
    expect(teacher.transcript.speakerCount).toBe(3);
    expect(teacher.transcript.segments.map((x: any) => x.speaker.name ?? x.speaker.kind)).toEqual([
      w.teacher.fullName,
      w.teacher.fullName,
      w.s[0].fullName,
      w.s[1].fullName,
      'UNKNOWN',
      w.teacher.fullName,
    ]);
    const b: any = await live.sessionDetail(w.s[1].id, w.ls.id, { transcript: 'full' });
    expect(b.transcript.segments.map((x: any) => x.speaker)).toEqual([
      { kind: 'TEACHER', name: w.teacher.fullName },
      { kind: 'TEACHER', name: w.teacher.fullName },
      { kind: 'STUDENT', ordinal: 1 },
      { kind: 'STUDENT', self: true },
      { kind: 'UNKNOWN' },
      { kind: 'TEACHER', name: w.teacher.fullName },
    ]);
    for (const body of [JSON.stringify(teacher.transcript), JSON.stringify(b.transcript)]) {
      for (const u of [w.teacher.id, w.s[0].id, w.s[1].id]) expect(body).not.toContain(u);
    }
    expect(JSON.stringify(b.transcript)).not.toContain(w.s[0].fullName!);
  });

  it('an older transcript (no speakers) reads exactly as before', async () => {
    if (!guard()) return;
    const segments = [{ startSec: 0, durationSec: 180, text: 'قديم' }];
    const w = await classroomWorld(prisma, {
      status: 'ENDED',
      endedAt: new Date(),
      transcriptStatus: 'READY',
      transcriptText: 'قديم',
      transcriptSegments: segments,
      transcriptVisibility: 'STUDENTS',
    });
    const { live } = classroom(prisma);
    const d: any = await live.sessionDetail(w.s[0].id, w.ls.id, { transcript: 'full' });
    expect(d.transcript.segments).toEqual(segments);
    expect(d.transcript.speakerCount).toBe(0);
    const plain: { startSec: number; durationSec: number; text: string; speaker?: undefined }[] = segments;
    expect(segmentsFor(plain, { teacher: false, userId: null })).toEqual(segments);
  });
});

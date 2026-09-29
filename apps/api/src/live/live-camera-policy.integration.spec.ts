import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { LiveRecordingService } from './recording/live-recording.service';
import { LiveRecorderWorker } from './recording/live-recorder.worker';
import {
  classroom,
  classroomWorld,
  codeOf,
  enterRoom,
  OFFER,
  type ClassroomWorld,
} from './testing/classroom';

/**
 * Live V1 Phase E on a real PostgreSQL: students' cameras. The class's
 * policy (SPEAKERS_ONLY default / OPTIONAL / EXPECTED / OFF), a moderator's
 * per-run exemption or block, and privacy enforced where it cannot be
 * bypassed: a non-speaking student's camera is pulled by moderators only,
 * and never burned into the recording. Nothing ever switches a camera on.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, [
    'liveSession',
    'liveParticipantControl',
    'liveRtcTrack',
  ]);
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
const policy = (
  c: C,
  w: ClassroomWorld,
  cameraPolicy: 'SPEAKERS_ONLY' | 'OPTIONAL' | 'EXPECTED' | 'OFF',
) => c.rtc.setCameraPolicy(w.ls.id, cameraPolicy, w.teacher.id);

/** A student publishes kinds on their SEND connection (opened if needed). */
async function send(
  c: C,
  w: ClassroomWorld,
  userId: string,
  kinds: ('AUDIO' | 'VIDEO')[],
  conn?: string,
) {
  const connectionId = conn ?? (await c.rtc.openConnection(userId, w.ls.id, 'SEND')).connectionId;
  let mid = (await prisma.liveRtcTrack.count({ where: { connectionId } })) + 10;
  await c.rtc.publish(userId, w.ls.id, connectionId, {
    offer: OFFER,
    tracks: kinds.map((kind) => ({ mid: String(mid++), kind })),
  });
  const tracks = await prisma.liveRtcTrack.findMany({
    where: { connectionId, closedAt: null },
    select: { id: true, kind: true, trackName: true },
  });
  const of = (k: string) => tracks.find((t) => t.kind === k)!;
  return { connectionId, of };
}
const approve = async (c: C, w: ClassroomWorld, userId: string) => {
  await c.rtc.hand(userId, w.ls.id, 'raise');
  await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', userId);
};

describe('SPEAKERS_ONLY (the default — the behaviour before this change)', () => {
  it('a camera only while allowed to speak; losing the floor takes both', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    expect(await codeOf(c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
    await approve(c, w, w.s[0].id);
    const { of } = await send(c, w, w.s[0].id, ['AUDIO', 'VIDEO']);
    const [a, v] = [of('AUDIO').trackName, of('VIDEO').trackName];
    await c.rtc.hand(w.teacher.id, w.ls.id, 'revoke', w.s[0].id);
    expect(c.sfu.active(a)).toBe(false);
    expect(c.sfu.active(v)).toBe(false);
  });
});

describe('OPTIONAL', () => {
  it('any student may turn their camera on; the microphone still needs the teacher', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    const { connectionId, of } = await send(c, w, w.s[0].id, ['VIDEO']);
    expect(c.sfu.active(of('VIDEO').trackName)).toBe(true);
    expect(await codeOf(send(c, w, w.s[0].id, ['AUDIO'], connectionId))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
  });

  it('revoking the floor closes the microphone and leaves the camera running', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    const cam = await send(c, w, w.s[0].id, ['VIDEO']);
    await approve(c, w, w.s[0].id);
    const mic = await send(c, w, w.s[0].id, ['AUDIO'], cam.connectionId);
    const [v, a] = [cam.of('VIDEO').trackName, mic.of('AUDIO').trackName];
    await c.rtc.hand(w.teacher.id, w.ls.id, 'revoke', w.s[0].id);
    expect(c.sfu.active(a)).toBe(false);
    expect(c.sfu.active(v)).toBe(true);
    const open = await prisma.liveRtcTrack.findMany({
      where: { connectionId: cam.connectionId, closedAt: null },
    });
    expect(open.map((t) => t.kind)).toEqual(['VIDEO']);
    // The connection is still theirs: the camera keeps going.
    expect(
      (await prisma.liveRtcConnection.findUniqueOrThrow({ where: { id: cam.connectionId } }))
        .closedAt,
    ).toBeNull();
  });
});

describe('EXPECTED — asked, shown, exemptable; never switched on', () => {
  it('students are asked; an exemption lifts it; the teacher sees who and why', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    for (const s of w.s) await enterRoom(prisma, c, w, s.id);
    await policy(c, w, 'EXPECTED');
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.policy.cameraExpected).toBe(true);
    // No camera was published by anyone: expecting is not activating.
    expect(await prisma.liveRtcTrack.count({ where: { sessionId: w.ls.id, kind: 'VIDEO' } })).toBe(
      0,
    );
    // The page reports the permission was denied; the teacher sees it.
    await c.rtc.reportCamera(w.s[1].id, w.ls.id, 'DENIED');
    await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { camera: 'EXEMPT' });
    const st = await c.rtc.state(w.teacher.id, w.ls.id);
    const row = (uid: string) => st.participants.find((p) => p.userId === uid)!;
    expect(row(w.s[0].id)).toMatchObject({ cameraExpected: false, controls: { camera: 'EXEMPT' } });
    expect(row(w.s[1].id)).toMatchObject({
      cameraExpected: true,
      controls: { cameraReport: 'DENIED' },
    });
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.policy).toMatchObject({
      cameraExpected: false,
      cameraExempt: true,
    });
    // An exempt student may still turn it on.
    await send(c, w, w.s[0].id, ['VIDEO']);
    // Fixed on the device: the report clears.
    await c.rtc.reportCamera(w.s[1].id, w.ls.id, null);
    expect(
      (await c.rtc.state(w.teacher.id, w.ls.id)).participants.find((p) => p.userId === w.s[1].id)
        ?.controls?.cameraReport,
    ).toBeNull();
  });

  it('a camera reminder is a prompt to the student, at most once a minute, from a moderator', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'EXPECTED');
    expect(await c.rtc.nudgeCamera(w.teacher.id, w.ls.id, w.s[0].id)).toEqual({ sent: true });
    expect(await c.rtc.nudgeCamera(w.teacher.id, w.ls.id, w.s[0].id)).toEqual({ sent: false });
    expect(c.events.filter((e) => e.event === 'live:nudge' && e.id === w.s[0].id)).toHaveLength(1);
    expect(await codeOf(c.rtc.nudgeCamera(w.assistant.id, w.ls.id, w.s[0].id))).toBe(
      'NOT_A_MODERATOR',
    );
    expect(await codeOf(c.rtc.nudgeCamera(w.s[1].id, w.ls.id, w.s[0].id))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
  });
});

describe('OFF and BLOCKED', () => {
  it('OFF: no student camera — switching to it closes the ones running, a speaker’s too', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    const s0 = await send(c, w, w.s[0].id, ['VIDEO']);
    await approve(c, w, w.s[1].id);
    const s1 = await send(c, w, w.s[1].id, ['AUDIO', 'VIDEO']);
    await policy(c, w, 'OFF');
    expect(c.sfu.active(s0.of('VIDEO').trackName)).toBe(false);
    expect(c.sfu.active(s1.of('VIDEO').trackName)).toBe(false);
    expect(c.sfu.active(s1.of('AUDIO').trackName)).toBe(true); // the voice is not the camera
    expect(await codeOf(send(c, w, w.s[2].id, ['VIDEO']))).toBe('NOT_ALLOWED_TO_SPEAK');
  });

  it('a camera BLOCKED for one student: refused and closed, this run only', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    const s0 = await send(c, w, w.s[0].id, ['VIDEO']);
    await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { camera: 'BLOCKED' });
    expect(c.sfu.active(s0.of('VIDEO').trackName)).toBe(false);
    expect(await codeOf(send(c, w, w.s[0].id, ['VIDEO']))).toBe('NOT_ALLOWED_TO_SPEAK');
    // A new run: the block does not carry over.
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { roomName: `cf-${w.k}-run2` },
    });
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.policy.cameraBlocked).toBe(false);
  });
});

describe("privacy: a non-speaking student's camera reaches moderators only", () => {
  it('another student can neither see it listed nor pull it; the teacher can; once speaking, everyone can', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    const cam = await send(c, w, w.s[0].id, ['VIDEO']);
    const camId = cam.of('VIDEO').id;
    const peer = await c.rtc.openConnection(w.s[1].id, w.ls.id, 'RECEIVE');
    // Not in the peer's state at all…
    expect((await c.rtc.state(w.s[1].id, w.ls.id)).tracks.map((t) => t.id)).not.toContain(camId);
    // …and refused by the server when asked for directly (the page is not trusted).
    expect(
      await codeOf(c.rtc.subscribe(w.s[1].id, w.ls.id, peer.connectionId, { trackIds: [camId] })),
    ).toBe('RTC_TRACK_DENIED');
    // A staff member who may not moderate is refused too.
    const obs = await c.rtc.openConnection(w.assistant.id, w.ls.id, 'RECEIVE');
    expect(
      await codeOf(
        c.rtc.subscribe(w.assistant.id, w.ls.id, obs.connectionId, { trackIds: [camId] }),
      ),
    ).toBe('RTC_TRACK_DENIED');
    // The teacher receives it.
    const t = await c.rtc.openConnection(w.teacher.id, w.ls.id, 'RECEIVE');
    expect(
      (await c.rtc.subscribe(w.teacher.id, w.ls.id, t.connectionId, { trackIds: [camId] }))
        .tracks[0].error,
    ).toBeNull();
    // Given the floor: the class presentation shows speakers to everyone.
    await approve(c, w, w.s[0].id);
    expect((await c.rtc.state(w.s[1].id, w.ls.id)).tracks.map((x) => x.id)).toContain(camId);
    expect(
      await codeOf(c.rtc.subscribe(w.s[1].id, w.ls.id, peer.connectionId, { trackIds: [camId] })),
    ).toBe('ok');
  });
});

describe('the recorder: teacher and active speakers only', () => {
  it('a camera-on non-speaker is never composited; a speaker is; the teacher still sees both live', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await policy(c, w, 'OPTIONAL');
    // The teacher's camera and voice.
    const tc = await c.rtc.openConnection(w.teacher.id, w.ls.id, 'SEND');
    await c.rtc.publish(w.teacher.id, w.ls.id, tc.connectionId, {
      offer: OFFER,
      tracks: [
        { mid: '0', kind: 'AUDIO' },
        { mid: '1', kind: 'VIDEO' },
      ],
    });
    const listener = await send(c, w, w.s[0].id, ['VIDEO']); // camera on, not speaking
    await approve(c, w, w.s[1].id);
    const speaker = await send(c, w, w.s[1].id, ['AUDIO', 'VIDEO']);

    // The real worker's page state: what the recorder page is told to pull.
    const recordings = new LiveRecordingService(prisma, c.live, c.rtc);
    const worker = new LiveRecorderWorker(
      prisma,
      {} as never,
      {} as never,
      c.cloudflare,
      c.rtc,
      recordings,
    );
    const rec = await prisma.liveRecording.create({
      data: {
        sessionId: w.ls.id,
        roomName: w.ls.roomName!,
        tenantId: w.tp.id,
        requestedBy: w.teacher.id,
        status: 'RECORDING',
        leaseOwner: worker.workerId,
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const page = await (worker as any).pageState({ rec, startedAt: Date.now(), lost: false });
    const ids = (page.tracks as { id: string }[]).map((t) => t.id);
    expect(ids).not.toContain(listener.of('VIDEO').id);
    expect(ids).toContain(speaker.of('VIDEO').id);
    expect(ids).toContain(speaker.of('AUDIO').id);
    expect(page.tracks.filter((t: { role: string }) => t.role === 'TEACHER')).toHaveLength(2);
    // The teacher's own view still has the listener's camera.
    expect((await c.rtc.state(w.teacher.id, w.ls.id)).tracks.map((t) => t.id)).toContain(
      listener.of('VIDEO').id,
    );
    // Even a direct pull by the recorder for that track gets nothing.
    const pulled = await (worker as any).pageCf({ rec, cfSessionId: 'x' }, 'subscribe', {
      trackIds: [listener.of('VIDEO').id],
    });
    expect(pulled.tracks).toEqual([]);
    // The speaker loses the floor: out of the recording.
    await c.rtc.hand(w.teacher.id, w.ls.id, 'revoke', w.s[1].id);
    const after = await (worker as any).pageState({ rec, startedAt: Date.now(), lost: false });
    expect((after.tracks as { id: string }[]).map((t) => t.id)).not.toContain(
      speaker.of('VIDEO').id,
    );
  });
});

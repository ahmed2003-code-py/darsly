import { randomUUID } from 'crypto';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CF_STUN } from '../providers/cloudflare-realtime.client';
import { LiveProviders } from '../providers/live-providers';
import { transcriptCaptureState } from './capture-state';

/**
 * Checkpoint C on a real PostgreSQL: OFF / MANUAL / AUTO_WHEN_RECORDING.
 * Recording and transcription are separate things; the mode is what joins
 * them, and only AUTO_WHEN_RECORDING does.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;
const env = { ...process.env };

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveAudioSegment']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
beforeEach(() => {
  process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
});
afterEach(() => {
  process.env = { ...env };
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

function build() {
  const client = {
    configured: true,
    turnConfigured: false,
    iceServers: jest.fn(async () => [CF_STUN]),
    closeTracks: jest.fn(async () => ({})),
    getSession: jest.fn(async () => ({ tracks: [] })),
  };
  const cloudflare = new CloudflareLiveProvider(prisma, client as any);
  const providers = new LiveProviders([cloudflare], 'CLOUDFLARE');
  const queued: any[] = [];
  const jobs = {
    enqueue: jest.fn(async (academyId: string, type: string, input: any) => {
      queued.push({ academyId, type, input });
      return { id: `job-${queued.length}` };
    }),
    hasActiveJobFor: jest.fn(async () => false),
  };
  const realtime = { emitToLive: jest.fn(), emitToUser: jest.fn() };
  const svc = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    {} as any,
    providers,
    realtime as any,
    jobs as any,
    {} as any,
  );
  return { svc, jobs, queued, realtime };
}

async function world(mode: 'OFF' | 'MANUAL' | 'AUTO_WHEN_RECORDING') {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `tm-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `tm-${k}` } });
  await prisma.academy.create({ data: { id: tp.id, slug: `tma-${k}`, name: `A ${k}`, ownerUserId: teacher.id } });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() - 5 * MIN),
      startedAt: new Date(Date.now() - 5 * MIN),
      durationMin: 60,
      status: 'LIVE',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}-run1`,
      transcriptionMode: mode,
    },
  });
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { teacher, tp, ls, scope };
}
const cap = (w: Awaited<ReturnType<typeof world>>) => transcriptCaptureState(prisma, w.ls.id, w.ls.roomName);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.response?.code ?? e?.message);
const record = (w: Awaited<ReturnType<typeof world>>, data: Record<string, unknown> = {}) =>
  prisma.liveRecording.create({
    data: {
      sessionId: w.ls.id,
      roomName: w.ls.roomName!,
      tenantId: w.tp.id,
      requestedBy: w.teacher.id,
      status: 'RECORDING',
      ...data,
    },
  });

describe('Checkpoint C: transcription modes', () => {
  it('AUTO_WHEN_RECORDING: captures while recording, stops when recording stops', async () => {
    if (!guard()) return;
    const w = await world('AUTO_WHEN_RECORDING');
    expect(await cap(w)).toMatchObject({ available: true, active: false, everOn: false });
    const rec = await record(w);
    expect((await cap(w)).active).toBe(true);
    await prisma.liveRecording.update({ where: { id: rec.id }, data: { stopRequestedAt: new Date() } });
    const off = await cap(w);
    expect(off).toMatchObject({ active: false, everOn: true });
    expect(off.lastOffAt).toBeInstanceOf(Date);
  });

  it('MANUAL: the teacher switches it — recording has nothing to do with it', async () => {
    if (!guard()) return;
    const w = await world('MANUAL');
    const { svc, realtime } = build();
    await record(w);
    expect((await cap(w)).active).toBe(false);
    expect(await svc.setTranscription(w.scope, w.ls.id, { capture: true })).toMatchObject({ capturing: true });
    expect(realtime.emitToLive).toHaveBeenCalledWith(w.ls.id, 'live:rtc-state', { sessionId: w.ls.id });
    await new Promise((r) => setTimeout(r, 5));
    expect(await svc.setTranscription(w.scope, w.ls.id, { capture: false })).toMatchObject({ capturing: false });
    expect((await cap(w)).everOn).toBe(true);
  });

  it('OFF: nothing is captured, whatever is recorded; the switch cannot be flipped', async () => {
    if (!guard()) return;
    const w = await world('OFF');
    const { svc } = build();
    await record(w);
    expect(await cap(w)).toMatchObject({ available: false, active: false });
    expect(await code(svc.setTranscription(w.scope, w.ls.id, { capture: true }))).toBe('NOT_MANUAL');
  });

  it('the global switch overrides every mode', async () => {
    if (!guard()) return;
    delete process.env.LIVE_TRANSCRIPTION_ENABLED;
    const w = await world('AUTO_WHEN_RECORDING');
    await record(w);
    expect(await cap(w)).toMatchObject({ available: false, active: false });
    const { svc } = build();
    expect(await code(svc.setTranscription(w.scope, w.ls.id, { capture: true }))).toBe('TRANSCRIPTION_OFF');
  });

  it('the mode can change until the class ends, not after', async () => {
    if (!guard()) return;
    const w = await world('OFF');
    const { svc } = build();
    expect(await svc.setTranscription(w.scope, w.ls.id, { mode: 'MANUAL' })).toMatchObject({ mode: 'MANUAL' });
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { status: 'ENDED', endedAt: new Date() } });
    expect(await code(svc.setTranscription(w.scope, w.ls.id, { mode: 'OFF' }))).toBe('ENDED');
  });

  it('the end of a class queues the transcript only when there was something to capture', async () => {
    if (!guard()) return;
    // AUTO and recorded: queued once, marked PROCESSING.
    const a = await world('AUTO_WHEN_RECORDING');
    await record(a);
    const b1 = build();
    await b1.svc.endSession(a.ls.id, 'MANUAL');
    expect(b1.queued.filter((q) => q.input.liveSessionId === a.ls.id)).toEqual([
      { academyId: a.tp.id, type: 'LIVE_TRANSCRIBE', input: { liveSessionId: a.ls.id, roomName: a.ls.roomName } },
    ]);
    expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: a.ls.id } })).transcriptStatus).toBe(
      'PROCESSING',
    );
    // Ending twice queues nothing more.
    await b1.svc.endSession(a.ls.id, 'MANUAL');
    expect(b1.queued.filter((q) => q.input.liveSessionId === a.ls.id)).toHaveLength(1);

    // AUTO, never recorded; MANUAL, never switched on; OFF: nothing queued, nothing paid.
    for (const mode of ['AUTO_WHEN_RECORDING', 'MANUAL', 'OFF'] as const) {
      const w = await world(mode);
      const b = build();
      await b.svc.endSession(w.ls.id, 'MANUAL');
      expect(b.queued).toHaveLength(0);
      expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).transcriptStatus).toBe(
        'NOT_STARTED',
      );
    }
  });

  it('the upload follows the same answer: a piece while capturing, not before', async () => {
    if (!guard()) return;
    const w = await world('MANUAL');
    const { svc } = build();
    const piece = () => {
      const b = Buffer.alloc(3000);
      b.writeUInt32BE(0x1a45dfa3, 0);
      return { buffer: b, size: b.length, mimetype: 'audio/webm' };
    };
    const now = Math.floor(Date.now() / 1000);
    (svc as any).storage = { put: jest.fn(async () => undefined) };
    expect(await code(svc.storeAudioPiece(w.scope, w.ls.id, now, piece()))).toBe('CAPTURE_OFF');
    await svc.setTranscription(w.scope, w.ls.id, { capture: true });
    expect(await code(svc.storeAudioPiece(w.scope, w.ls.id, now, piece(), 180_000))).toBe('ok');
    expect(await prisma.liveAudioSegment.count({ where: { sessionId: w.ls.id } })).toBe(1);
  });
});

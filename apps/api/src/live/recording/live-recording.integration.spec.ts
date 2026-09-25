import { randomUUID } from 'crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { dailyProviders } from '../providers/testing';
import { LiveRecordingService } from './live-recording.service';
import { LiveRecorderWorker, finalKey, segmentKey } from './live-recorder.worker';

/**
 * The recorder's bookkeeping on a real PostgreSQL, with every failure the
 * worker is meant to survive injected on purpose. Chrome and ffmpeg are not
 * needed: the page is never opened and `finalizeFn` is replaced; what is
 * tested is who owns a recording, what happens when that owner dies, and how
 * a finished recording reaches the video pipeline exactly once.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveRecording', 'videoAsset', 'videoJob']);
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

/** Object storage in memory, with a switch to make uploads fail. */
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const fail = { put: 0 };
  return {
    objects,
    fail,
    driver: 'local' as const,
    put: jest.fn(async (key: string, body: Buffer | Readable) => {
      if (fail.put > 0) {
        fail.put--;
        throw new Error('R2 unavailable');
      }
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(body)) chunks.push(body);
      else for await (const c of body) chunks.push(Buffer.from(c));
      objects.set(key, Buffer.concat(chunks));
    }),
    exists: jest.fn(async (key: string) => objects.has(key)),
    getStream: jest.fn(async (key: string) => ({
      stream: Readable.from(objects.get(key)!),
      contentLength: objects.get(key)!.length,
      totalSize: objects.get(key)!.length,
    })),
    delete: jest.fn(async (key: string) => void objects.delete(key)),
  };
}

function build(opts: { enqueueFails?: number } = {}) {
  const storage = fakeStorage();
  let enqueueFails = opts.enqueueFails ?? 0;
  const video = {
    enqueue: jest.fn(async (assetId: string, tenantId: string, tx: any) => {
      if (enqueueFails > 0) {
        enqueueFails--;
        throw new Error('queue unavailable');
      }
      await tx.videoAsset.update({ where: { id: assetId }, data: { status: 'PROCESSING' } });
      // Created already finished: a QUEUED job left on a shared test database
      // would be claimed by the video-job specs, which expect none but theirs.
      await tx.videoJob.create({ data: { videoAssetId: assetId, tenantId, status: 'SUCCEEDED' } });
    }),
  };
  const rtc = { changed: jest.fn(), openTracks: jest.fn(async () => []) };
  const live = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    {} as any,
    dailyProviders({}),
    { emitToLive: jest.fn(), emitToUser: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  const recordings = new LiveRecordingService(prisma, live, rtc as any);
  const worker = (dir: string) => {
    const w = new LiveRecorderWorker(
      prisma,
      storage as any,
      video as any,
      { closeConnections: jest.fn(), client: {} } as any,
      rtc as any,
      recordings,
    );
    (w.cfg as any).dir = dir;
    // "ffmpeg": joins the pieces by concatenation, 1s per piece.
    w.finalizeFn = jest.fn(async (d: string) => {
      const segs = (await fs.readdir(d)).filter((f) => /^seg-\d+\.webm$/.test(f)).sort();
      const parts = await Promise.all(segs.map((f) => fs.readFile(path.join(d, f))));
      const data = Buffer.concat(parts);
      if (!data.length) throw new Error('NO_MEDIA');
      const file = path.join(d, 'final.webm');
      await fs.writeFile(file, data);
      return { file, sizeBytes: data.length, durationSec: segs.length };
    });
    return w;
  };
  return { storage, video, rtc, live, recordings, worker };
}

async function world() {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `rt-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `rt-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `ra-${k}`, name: `A ${k}`, ownerUserId: teacher.id },
  });
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
    },
  });
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { k, teacher, tp, ls, scope };
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'rec-it-'));

/** A recording as the recorder leaves it after writing `n` pieces (uploaded ones in storage). */
async function recorded(
  b: ReturnType<typeof build>,
  w: Awaited<ReturnType<typeof world>>,
  pieces: { uploaded: boolean; bytes?: string }[],
) {
  const rec = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
  for (const [n, p] of pieces.entries()) {
    if (p.uploaded)
      b.storage.objects.set(segmentKey(rec.id, n), Buffer.from(p.bytes ?? `piece${n}`));
  }
  await prisma.liveRecording.update({
    where: { id: rec.id },
    data: { status: 'UPLOADING', segments: pieces.length, startedAt: new Date() },
  });
  return rec;
}

describe('B.6 recorder on Postgres: requests', () => {
  it('two presses of "record" are one recording', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const [a, c] = await Promise.all([
      b.recordings.start(w.scope, w.ls.id, w.teacher.id),
      b.recordings.start(w.scope, w.ls.id, w.teacher.id),
    ]);
    expect(a.id).toBe(c.id);
    expect(await prisma.liveRecording.count({ where: { sessionId: w.ls.id } })).toBe(1);
    expect(
      (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).recordingStatus,
    ).toBe('PROCESSING');
    expect(await b.recordings.isRecording(w.ls.id, w.ls.roomName!)).toBe(true);
  });

  it('refuses a class that is not running; a stop before the recorder started keeps nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { status: 'ENDED' } });
    await expect(b.recordings.start(w.scope, w.ls.id, w.teacher.id)).rejects.toMatchObject({
      response: { code: 'NOT_STARTED' },
    });
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { status: 'LIVE' } });
    const r = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
    await b.recordings.stop(w.scope, w.ls.id);
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'FAILED', error: 'STOPPED_BEFORE_START' });
    expect(await b.recordings.isRecording(w.ls.id, w.ls.roomName!)).toBe(false);
  });
});

describe('B.6 recorder on Postgres: ownership and crashes', () => {
  it('two recorders never claim the same recording', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
    const dir = await tmp();
    const [x, y] = [b.worker(dir), b.worker(dir)];
    // Everything else REQUESTED on the shared test database is claimed too;
    // what matters is that this one is claimed exactly once.
    const claims: string[] = [];
    for (let i = 0; i < 20; i++) {
      const got = await Promise.all([x.claim(), y.claim()]);
      for (const g of got) if (g) claims.push(g.id);
      if (!got[0] && !got[1]) break;
    }
    expect(claims.filter((id) => id === r.id)).toHaveLength(1);
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('RECORDING');
    expect([x.workerId, y.workerId]).toContain(row.leaseOwner);
  });

  it('a heartbeat keeps the lease, whatever time zone the database is in', async () => {
    if (!guard()) return;
    const [{ TimeZone: tz }] = await prisma.$queryRaw<{ TimeZone: string }[]>`SHOW timezone`;
    const w = await world();
    const b = build();
    const r = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
    const dir = await tmp();
    const holder = b.worker(dir);
    const other = b.worker(dir);
    let mine = null;
    for (let i = 0; i < 20 && !mine; i++) {
      const c = await holder.claim();
      if (!c) break;
      if (c.id === r.id) mine = c;
    }
    expect(mine).not.toBeNull();
    // The recorder is alive and says so (what it does every 10s).
    const job = { rec: mine, bytes: 10, startedAt: Date.now(), lost: false } as any;
    await (holder as any).heartbeat(job);
    expect(job.lost).toBe(false);
    // Nobody else may take it while the lease holds — the bug this guards
    // against made every heartbeat look expired on a non-UTC database.
    const grabbed: string[] = [];
    for (let i = 0; i < 20; i++) {
      const c = await other.claim();
      if (!c) break;
      grabbed.push(c.id);
    }
    expect(grabbed).not.toContain(r.id);
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.leaseOwner).toBe(holder.workerId);
    // The lease is ~30s ahead in UTC, as Prisma reads it.
    const ahead = row.leaseUntil!.getTime() - Date.now();
    expect(ahead).toBeGreaterThan(20_000);
    expect(ahead).toBeLessThan(35_000);
    console.log(`database time zone during this test: ${tz}`);
  });

  it('a recorder that stops renewing its lease is taken over, and gives up after the limit', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
    const dir = await tmp();
    const dead = b.worker(dir);
    const next = b.worker(dir);
    // Claim it as the first recorder (draining any other REQUESTED rows).
    let mine = null;
    for (let i = 0; i < 20 && !mine; i++) {
      const c = await dead.claim();
      if (!c) break;
      if (c.id === r.id) mine = c;
    }
    expect(mine).not.toBeNull();
    // It dies: the lease runs out.
    await prisma.liveRecording.update({
      where: { id: r.id },
      data: { leaseUntil: new Date(Date.now() - 1000), segments: 2 },
    });
    let taken = null;
    for (let i = 0; i < 20 && !taken; i++) {
      const c = await next.claim();
      if (!c) break;
      if (c.id === r.id) taken = c;
    }
    expect(taken).toMatchObject({ leaseOwner: next.workerId, attempts: 2, segments: 2 });
    // Crashing again and again: past the limit it goes to finalize with what exists.
    await prisma.liveRecording.update({
      where: { id: r.id },
      data: { leaseUntil: new Date(Date.now() - 1000), attempts: 6 },
    });
    for (let i = 0; i < 20; i++) if (!(await next.claim())) break;
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'UPLOADING', error: 'RECORDER_GAVE_UP' });
  });

  it('a recorder crash never touches the class', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await b.recordings.start(w.scope, w.ls.id, w.teacher.id);
    await prisma.liveRecording.update({
      where: { id: r.id },
      data: { status: 'FAILED', error: 'crash' },
    });
    const s = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(s.status).toBe('LIVE');
  });
});

describe('B.6 recorder on Postgres: handing over to the video pipeline', () => {
  it('joins the pieces, uploads, and creates the asset and its job together', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await recorded(b, w, [{ uploaded: true }, { uploaded: true }, { uploaded: true }]);
    const worker = b.worker(await tmp());
    const row0 = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    await worker.finalize(row0);
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.durationSec).toBe(3);
    const asset = await prisma.videoAsset.findUniqueOrThrow({ where: { id: row.videoAssetId! } });
    expect(asset).toMatchObject({
      tenantId: w.tp.id,
      originalKey: finalKey(r.id),
      status: 'PROCESSING',
    });
    expect(await prisma.videoJob.count({ where: { videoAssetId: asset.id } })).toBe(1);
    expect(b.storage.objects.get(finalKey(r.id))?.toString()).toBe('piece0piece1piece2');
    // The pieces are gone from storage once joined.
    expect([...b.storage.objects.keys()].filter((k) => k.includes('/seg-'))).toHaveLength(0);
  });

  it('an upload that fails leaves it to be retried — later, and then it goes through', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await recorded(b, w, [{ uploaded: true }]);
    b.storage.fail.put = 1;
    const worker = b.worker(await tmp());
    await worker.finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } }));
    let row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('UPLOADING');
    expect(row.error).toMatch(/FINALIZE: R2 unavailable/);
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(Date.now()); // backing off
    expect(await prisma.videoAsset.count({ where: { originalKey: finalKey(r.id) } })).toBe(0);
    await worker.finalize(row);
    row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PROCESSING');
  });

  it('a queue that refuses leaves no orphan asset behind', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build({ enqueueFails: 1 });
    const r = await recorded(b, w, [{ uploaded: true }]);
    const worker = b.worker(await tmp());
    await worker.finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } }));
    expect(await prisma.videoAsset.count({ where: { originalKey: finalKey(r.id) } })).toBe(0);
    expect((await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
      'UPLOADING',
    );
    await worker.finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } }));
    expect(await prisma.videoAsset.count({ where: { originalKey: finalKey(r.id) } })).toBe(1);
  });

  it('two recorders finishing the same recording hand it over once', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await recorded(b, w, [{ uploaded: true }]);
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    await Promise.all([b.worker(await tmp()).finalize(row), b.worker(await tmp()).finalize(row)]);
    expect(await prisma.videoAsset.count({ where: { originalKey: finalKey(r.id) } })).toBe(1);
    expect(b.video.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a piece that never reached storage is reported, the rest is kept', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await recorded(b, w, [{ uploaded: true }, { uploaded: false }, { uploaded: true }]);
    await b
      .worker(await tmp())
      .finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } }));
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.error).toBe('PARTIAL: segments lost 1');
    expect(b.storage.objects.get(finalKey(r.id))?.toString()).toBe('piece0piece2');
  });

  it('nothing recorded at all is a failed recording, not an empty video', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r = await recorded(b, w, [{ uploaded: false }]);
    await b
      .worker(await tmp())
      .finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } }));
    const row = await prisma.liveRecording.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ status: 'FAILED', error: 'NO_MEDIA' });
    expect(
      (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).recordingStatus,
    ).toBe('FAILED');
  });

  it('follows the pipeline: READY when the HLS is, FAILED when packaging gives up', async () => {
    if (!guard()) return;
    const w = await world();
    const b = build();
    const r1 = await recorded(b, w, [{ uploaded: true }]);
    await b
      .worker(await tmp())
      .finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r1.id } }));
    const a1 = (await prisma.liveRecording.findUniqueOrThrow({ where: { id: r1.id } }))
      .videoAssetId!;
    await prisma.videoAsset.update({
      where: { id: a1 },
      data: { status: 'READY', durationSec: 42 },
    });
    for (let i = 0; i < 20; i++) if (!(await b.recordings.syncProcessing(100))) break;
    expect(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({
      status: 'READY',
      durationSec: 42,
    });
    expect(await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).toMatchObject({
      recordingStatus: 'READY',
      recordingDuration: 42,
    });
    const w2 = await world();
    const r2 = await recorded(b, w2, [{ uploaded: true }]);
    await b
      .worker(await tmp())
      .finalize(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r2.id } }));
    const a2 = (await prisma.liveRecording.findUniqueOrThrow({ where: { id: r2.id } }))
      .videoAssetId!;
    await prisma.videoAsset.update({ where: { id: a2 }, data: { status: 'FAILED' } });
    for (let i = 0; i < 20; i++) if (!(await b.recordings.syncProcessing(100))) break;
    expect(await prisma.liveRecording.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({
      status: 'FAILED',
      error: 'PACKAGING_FAILED',
    });
  });
});

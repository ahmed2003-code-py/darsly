import { randomUUID } from 'crypto';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { PlaybackController } from '../../playback/playback.controller';
import { SignedUrlService } from '../../playback/signed-url.service';
import { NativeAesDrmProvider } from '../../video/drm/native-aes.provider';
import { KEY_URI_PLACEHOLDER } from '../../video/transcode.service';
import { LiveScope, LiveService } from '../live.service';
import { dailyProviders } from '../providers/testing';
import { LiveReplayService } from './live-replay.service';

/**
 * Checkpoint C on a real PostgreSQL: watching a live lesson's recording inside
 * Darsly, and every way of not being allowed to.
 *
 * Real: the rules (LiveService, LiveReplayService), the signed tokens
 * (SignedUrlService), the credentials (NativeAesDrmProvider) and the HLS
 * delivery + key endpoint (PlaybackController). Fake: object storage (the
 * packaged HLS files, in memory) and the key store.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;
process.env.VIDEO_SIGNING_SECRET = process.env.VIDEO_SIGNING_SECRET ?? 'test-signing-secret-for-replay-spec';

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveReplaySession', 'videoAsset']);
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

/** The packaged HLS of every asset, in memory, as the transcoder would leave it. */
const files = new Map<string, Buffer>();
const storage = {
  exists: jest.fn(async (k: string) => files.has(k)),
  getBuffer: jest.fn(async (k: string) => files.get(k)!),
  getStream: jest.fn(async (k: string) => {
    const b = files.get(k)!;
    const { Readable } = await import('node:stream');
    return { stream: Readable.from(b), contentLength: b.length, totalSize: b.length, range: null };
  }),
};
const KEY = Buffer.alloc(16, 7);
const keys = { getKeyBytes: jest.fn(async () => KEY) };

function build() {
  const signer = new SignedUrlService();
  const drm = new NativeAesDrmProvider({} as any, {} as any, {} as any, signer);
  const providers = dailyProviders({});
  const live = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    {} as any,
    providers,
    { emitToLive: jest.fn(), emitToUser: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  const replays = new LiveReplayService(prisma, live, drm);
  const playback = new PlaybackController({} as any, signer, storage as any, keys as any, prisma);
  return { signer, live, replays, playback };
}

/** A response object that records what the controller sent. */
function res() {
  const r: any = { headers: {}, statusCode: 200, body: undefined as any };
  r.setHeader = (k: string, v: unknown) => (r.headers[k] = v);
  r.status = (c: number) => ((r.statusCode = c), r);
  r.send = (b: unknown) => ((r.body = b), r);
  return r;
}

/** An ended Cloudflare class with a READY recording, its teacher, 2 booked students and 1 outsider. */
async function world(opts: { recording?: 'READY' | 'PROCESSING' | 'NONE'; provider?: 'CLOUDFLARE' | 'DAILY' } = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `rpt-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `rpt-${k}` } });
  await prisma.academy.create({ data: { id: tp.id, slug: `rpa-${k}`, name: `A ${k}`, ownerUserId: teacher.id } });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() - 70 * MIN),
      startedAt: new Date(Date.now() - 70 * MIN),
      endedAt: new Date(Date.now() - 10 * MIN),
      durationMin: 60,
      status: 'ENDED',
      provider: opts.provider ?? 'CLOUDFLARE',
      roomName: `cf-${k}-run1`,
    },
  });
  const students = [];
  for (let i = 0; i < 3; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `S${i} ${k}`, email: `rps${i}-${k}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    if (i < 2) await prisma.liveBooking.create({ data: { sessionId: ls.id, studentId: sp.id } });
    students.push({ u, sp });
  }
  let assetId: string | null = null;
  if ((opts.recording ?? 'READY') !== 'NONE') {
    const ready = (opts.recording ?? 'READY') === 'READY';
    const key = await prisma.hlsEncryptionKey.create({ data: { keyHex: KEY.toString('hex') } as any }).catch(() => null);
    const asset = await prisma.videoAsset.create({
      data: {
        tenantId: tp.id,
        originalKey: `source/live-rec/x-${k}/final.webm`,
        status: ready ? 'READY' : 'PROCESSING',
        durationSec: 1200,
        hlsMasterKey: ready ? `hls/PLACEHOLDER/master.m3u8` : null,
        encryptionKeyId: key?.id ?? `key-${k}`,
      },
    });
    assetId = asset.id;
    if (ready) {
      await prisma.videoAsset.update({ where: { id: asset.id }, data: { hlsMasterKey: `hls/${asset.id}/master.m3u8` } });
      files.set(`hls/${asset.id}/master.m3u8`, Buffer.from('#EXTM3U\n720p/index.m3u8\n'));
      files.set(
        `hls/${asset.id}/720p/index.m3u8`,
        Buffer.from(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI_PLACEHOLDER}"\nseg0.ts\n`),
      );
      files.set(`hls/${asset.id}/720p/seg0.ts`, Buffer.from('encrypted-bytes'));
    }
    await prisma.liveRecording.create({
      data: {
        sessionId: ls.id,
        roomName: ls.roomName!,
        tenantId: tp.id,
        requestedBy: teacher.id,
        status: ready ? 'READY' : 'PROCESSING',
        videoAssetId: asset.id,
      },
    });
  }
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { k, teacher, tp, ls, booked: students.slice(0, 2), outsider: students[2], scope, assetId };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e?.response?.code ?? e?.response?.message ?? e?.message,
  );
const tokenOf = (masterUrl: string) => masterUrl.match(/hls\/([^/]+)\/master\.m3u8/)![1];
const who = (u: { id: string }) => ({ sub: u.id });

describe('Checkpoint C: replay of a live recording, inside Darsly', () => {
  it('the teacher watches: master, media playlist (key URI rewritten), segment, key', async () => {
    if (!guard()) return;
    const w = await world();
    const { replays, playback } = build();
    const r = await replays.start(who(w.teacher), w.ls.id, {});
    expect(r.masterUrl).toMatch(/^\/api\/v1\/playback\/hls\/[^/]+\/master\.m3u8$/);
    expect(JSON.stringify(r)).not.toMatch(/source\/|live-rec|final\.webm|r2|amazonaws/);
    const t = tokenOf(r.masterUrl);
    const m = res();
    await playback.master(t, undefined as any, m);
    expect(m.body).toContain('#EXTM3U');
    const v = res();
    await playback.media(t, '720p', 'index.m3u8', undefined as any, { headers: {} } as any, v);
    expect(v.body).toContain(`/api/v1/playback/key/${t}`);
    expect(v.body).not.toContain(KEY_URI_PLACEHOLDER);
    const k = res();
    await playback.key(t, undefined as any, k);
    expect(Buffer.compare(k.body, KEY)).toBe(0);
    // The token lives as long as the recording (20 min + slack), not 5 minutes.
    const row = await prisma.liveReplaySession.findUniqueOrThrow({ where: { id: r.replaySessionId } });
    expect(row.expiresAt.getTime() - row.startedAt.getTime()).toBeGreaterThan(40 * MIN);
    expect(row.role).toBe('TEACHER');
  });

  it('a booked student watches only once the RECORDING is shared — not the summary', async () => {
    if (!guard()) return;
    const w = await world();
    const { replays, live, playback } = build();
    const s = w.booked[0].u;
    expect(await code(replays.start(who(s), w.ls.id, {}))).toBe('RECORDING_NOT_SHARED');
    // Sharing the summary shares the summary.
    await live.setVisibility(w.scope, w.ls.id, { summary: 'STUDENTS' });
    expect(await code(replays.start(who(s), w.ls.id, {}))).toBe('RECORDING_NOT_SHARED');
    await live.setVisibility(w.scope, w.ls.id, { recording: 'STUDENTS' });
    const r = await replays.start(who(s), w.ls.id, {});
    const k = res();
    await playback.key(tokenOf(r.masterUrl), undefined as any, k);
    expect(Buffer.compare(k.body, KEY)).toBe(0);
  });

  it('an unbooked student, and a teacher of another academy, cannot start a replay', async () => {
    if (!guard()) return;
    const w = await world();
    const other = await world();
    const { replays, live } = build();
    await live.setVisibility(w.scope, w.ls.id, { recording: 'STUDENTS' });
    expect(await code(replays.start(who(w.outsider.u), w.ls.id, {}))).toBe('You are not in this session');
    expect(await code(replays.start(who(other.teacher), w.ls.id, {}))).toBe('You are not in this session');
    // Student of class B asking for class A.
    expect(await code(replays.start(who(other.booked[0].u), w.ls.id, {}))).toBe('You are not in this session');
  });

  it('the key is refused once sharing is withdrawn, the booking removed, or the replay ended', async () => {
    if (!guard()) return;
    const w = await world();
    const { replays, live, playback } = build();
    await live.setVisibility(w.scope, w.ls.id, { recording: 'STUDENTS' });
    const key = async (masterUrl: string) => code(playback.key(tokenOf(masterUrl), undefined as any, res()));

    const a = await replays.start(who(w.booked[0].u), w.ls.id, {});
    await live.setVisibility(w.scope, w.ls.id, { recording: 'PRIVATE' });
    expect(await key(a.masterUrl)).toBe('Recording not shared');
    await live.setVisibility(w.scope, w.ls.id, { recording: 'STUDENTS' });
    expect(await key(a.masterUrl)).toBe('ok');

    const b = await replays.start(who(w.booked[1].u), w.ls.id, {});
    await prisma.liveBooking.deleteMany({ where: { sessionId: w.ls.id, studentId: w.booked[1].sp.id } });
    expect(await key(b.masterUrl)).toBe('Not in this session');

    await replays.end(w.booked[0].u.id, w.ls.id, a.replaySessionId);
    expect(await key(a.masterUrl)).toBe('Replay not active');
    // Ending someone else's replay does nothing.
    const c = await replays.start(who(w.teacher), w.ls.id, {});
    expect(await replays.end(w.booked[0].u.id, w.ls.id, c.replaySessionId)).toEqual({ ended: false });
    expect(await key(c.masterUrl)).toBe('ok');
  });

  it('expired, forged and cross-asset tokens are refused at every HLS endpoint', async () => {
    if (!guard()) return;
    const w = await world();
    const other = await world();
    const { replays, playback, signer } = build();
    const r = await replays.start(who(w.teacher), w.ls.id, {});
    const t = tokenOf(r.masterUrl);
    const claims = signer.verify(t);

    // Expired.
    const expired = signer.sign({ ...claims, exp: undefined } as any, -5);
    expect(await code(playback.master(expired, undefined as any, res()))).toBe('Playback URL expired');
    expect(await code(playback.key(expired, undefined as any, res()))).toBe('Playback URL expired');

    // Forged: the asset changed in the body, the signature kept.
    const [body, sig] = t.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), aid: other.assetId }),
    ).toString('base64url');
    expect(await code(playback.master(`${forgedBody}.${sig}`, undefined as any, res()))).toBe(
      'Invalid playback signature',
    );

    // A valid token for asset A cannot reach asset B's files by path.
    expect(
      await code(playback.media(t, `../${other.assetId}/720p`, 'seg0.ts', undefined as any, { headers: {} } as any, res())),
    ).toBe('Token does not authorize this object');

    // A correctly signed token whose replay row belongs to another asset: no key.
    const mismatched = signer.sign({ ...claims, aid: other.assetId! } as any);
    expect(await code(playback.key(mismatched, undefined as any, res()))).toBe('Token mismatch');

    // A replay token cannot pass as a lesson preview (pv) to skip the checks.
    await replays.end(w.teacher.id, w.ls.id, r.replaySessionId);
    const asPreview = signer.sign({ ...claims, pv: 1 } as any);
    expect(await code(playback.key(asPreview, undefined as any, res()))).toBe('Replay not active');
  });

  it('nothing to watch yet, or a Daily class: said so, no session opened', async () => {
    if (!guard()) return;
    const processing = await world({ recording: 'PROCESSING' });
    const none = await world({ recording: 'NONE' });
    const daily = await world({ recording: 'NONE', provider: 'DAILY' });
    const { replays } = build();
    expect(await code(replays.start(who(processing.teacher), processing.ls.id, {}))).toBe('RECORDING_NOT_READY');
    expect(await code(replays.start(who(none.teacher), none.ls.id, {}))).toBe('RECORDING_NOT_READY');
    expect(await code(replays.start(who(daily.teacher), daily.ls.id, {}))).toBe('RECORDING_USE_LINK');
    expect(
      await prisma.liveReplaySession.count({
        where: { liveSessionId: { in: [processing.ls.id, none.ls.id, daily.ls.id] } },
      }),
    ).toBe(0);
  });

  it('recording, transcript and summary are shared independently', async () => {
    if (!guard()) return;
    const w = await world();
    const { live } = build();
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: {
        transcriptStatus: 'READY',
        transcriptText: 'كلام الحصة',
        transcriptSegments: [{ startSec: 0, durationSec: 180, text: 'كلام الحصة' }],
        summaryStatus: 'READY',
        summary: { summary: 'ملخص', topics: [], keyPoints: [], questionsAndAnswers: [], actionItems: [] },
      },
    });
    const s = w.booked[0].u.id;
    let d: any = await live.sessionDetail(s, w.ls.id);
    expect(d.recording.playable).toBe(false);
    expect(d.transcript).toBeNull();
    expect(d.summary.data).toBeNull();

    await live.setVisibility(w.scope, w.ls.id, { recording: 'STUDENTS', summary: 'STUDENTS' });
    d = await live.sessionDetail(s, w.ls.id);
    expect(d.recording).toMatchObject({ playable: true, stage: 'READY' });
    expect(d.recording.timeline).toBeUndefined();
    expect(d.summary.data).toMatchObject({ summary: 'ملخص' });
    expect(d.transcript).toBeNull(); // still private

    await live.setVisibility(w.scope, w.ls.id, { transcript: 'STUDENTS', recording: 'PRIVATE' });
    d = await live.sessionDetail(s, w.ls.id);
    expect(d.transcript.segments).toEqual([{ startSec: 0, durationSec: 180, text: 'كلام الحصة' }]);
    expect(d.transcript.reason).toBeNull();
    expect(d.transcript.mode).toBeUndefined();
    expect(d.recording.playable).toBe(false);

    // The teacher sees everything, with the choices and the timeline.
    const t: any = await live.sessionDetail(w.teacher.id, w.ls.id);
    expect(t.recording).toMatchObject({ playable: true, visibility: 'PRIVATE' });
    expect(t.recording.timeline).toBeDefined();
    expect(t.transcript).toMatchObject({ visibility: 'STUDENTS', stage: 'READY' });
    expect(t.summary.visibility).toBe('STUDENTS');
    // The legacy switch follows the summary's.
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.summaryForStudents).toBe(true);
  });
});

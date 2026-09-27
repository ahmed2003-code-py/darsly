import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { commerceStack, commerceWorld, fundWallet } from '../commerce/testing';

/**
 * Who can read a lesson's transcript and summary — the same people who may
 * watch its recording. On a real PostgreSQL with real seats (a wallet
 * purchase, a listener-confirmed guest, refunds, replay policies).
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.liveSession.count();
    S = commerceStack(prisma);
  } catch {
    available = false;
  }
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

let seq = Math.floor(Math.random() * 1e7);
const phone = () => `011${String(++seq).padStart(8, '0')}`;

/** A finished class with a READY transcript and summary, both shared with students. */
async function finishedClass(opts: Parameters<typeof commerceWorld>[1] = {}) {
  const w = await commerceWorld(prisma, { students: 2, startsInMs: 2 * 86_400_000, ...opts });
  const buyer = w.students[0];
  await fundWallet(prisma, S.ledger, buyer.sp.id, 100_000);
  await S.commerce.payWithWallet(buyer.user.id, w.session.id);
  // Guest: seat bought by transfer, confirmed by the listener.
  const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر');
  const ref = phone();
  await S.commerce.guestSubmitTransfer(accessToken, { method: 'VODAFONE_CASH', reference: ref, proofImageUrl: 'data:x' });
  await S.matching.ingest({ provider: 'VODAFONE_CASH', amountCents: purchase.studentPaysCents, reference: ref, externalId: randomUUID(), identities: [ref] });
  const guestUser = (await S.commerce.guestClassroomToken(accessToken)).user;
  const endedAt = new Date(Date.now() - 10 * 86_400_000);
  await prisma.liveSession.update({
    where: { id: w.session.id },
    data: {
      status: 'ENDED',
      startsAt: new Date(endedAt.getTime() - 3600_000),
      startedAt: new Date(endedAt.getTime() - 3600_000),
      endedAt,
      transcriptStatus: 'READY',
      transcriptText: 'نص الحصة',
      transcriptSegments: [{ startSec: 0, durationSec: 180, text: 'نص الحصة' }],
      transcriptMeta: { pieces: 1, model: 'gpt-4o-mini-transcribe', estUsd: 0.01, jobId: 'x' },
      summaryStatus: 'READY',
      summary: { summary: 'ملخص', topics: [], keyPoints: [], questionsAndAnswers: [], actionItems: [] },
      transcriptVisibility: 'STUDENTS',
      summaryVisibility: 'STUDENTS',
      recordingVisibility: 'STUDENTS',
    },
  });
  return { w, buyer, unrelated: w.students[1], guestUser, guestToken: accessToken };
}
const view = async (userId: string, sessionId: string) => {
  try {
    const d: any = await S.live.sessionDetail(userId, sessionId);
    return { transcript: (d.transcript?.segments?.length ?? 0) > 0, summary: !!d.summary?.data, keys: Object.keys(d) };
  } catch (e: any) {
    return { denied: e?.status ?? e?.message };
  }
};
/** Whether replay would be granted — the same verdict LiveReplayService applies. */
async function replayAllowed(userId: string, sessionId: string) {
  const { paidReplayVerdict } = await import('../commerce/replay-entitlement');
  const s = await prisma.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
  const booking = await prisma.liveBooking.findFirst({ where: { sessionId, student: { userId } }, select: { purchase: true } });
  const guest = booking ? null : await S.live.guestSeat(userId, sessionId);
  if (!booking && !guest) return false;
  return paidReplayVerdict((booking?.purchase ?? guest!.purchase) as any, s).ok;
}

describe('transcript and summary follow the replay entitlement', () => {
  it('teacher, staff, paying student and confirmed guest read both; an unrelated student cannot', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    expect(await view(c.w.teacher.id, c.w.session.id)).toMatchObject({ transcript: true, summary: true });
    expect(await view(c.buyer.user.id, c.w.session.id)).toMatchObject({ transcript: true, summary: true });
    expect(await view(c.guestUser.id, c.w.session.id)).toMatchObject({ transcript: true, summary: true });
    expect(await view(c.unrelated.user.id, c.w.session.id)).toHaveProperty('denied');
    // An academy assistant is the teacher side of the room.
    const staff = await prisma.user.create({ data: { role: 'TEACHER', fullName: 'Assistant', email: `as-${randomUUID().slice(0, 8)}@it.test` } });
    await prisma.academyMembership.create({ data: { userId: staff.id, academyId: c.w.academyId, role: 'ASSISTANT', status: 'ACTIVE', joinedAt: new Date() } });
    expect(await view(staff.id, c.w.session.id)).toMatchObject({ transcript: true, summary: true });
  });

  it('PRIVATE means private: a paying student sees neither', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    await prisma.liveSession.update({ where: { id: c.w.session.id }, data: { transcriptVisibility: 'PRIVATE', summaryVisibility: 'PRIVATE' } });
    expect(await view(c.buyer.user.id, c.w.session.id)).toMatchObject({ transcript: false, summary: false });
  });

  it('a refunded guest and a revoked guest lose the text with the seat', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    await prisma.livePurchase.updateMany({ where: { guestBuyer: { userId: c.guestUser.id } }, data: { status: 'REFUNDED' } });
    expect(await view(c.guestUser.id, c.w.session.id)).toHaveProperty('denied');
    const c2 = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    await prisma.livePurchase.updateMany({ where: { guestBuyer: { userId: c2.guestUser.id } }, data: { status: 'CANCELLED_BY_TEACHER' } });
    expect(await view(c2.guestUser.id, c2.w.session.id)).toHaveProperty('denied');
  });

  it('a refunded registered buyer loses the text with the seat', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    await prisma.livePurchase.updateMany({ where: { sessionId: c.w.session.id, studentId: c.buyer.sp.id }, data: { status: 'REFUNDED' } });
    const v = await view(c.buyer.user.id, c.w.session.id);
    expect('denied' in v || (!v.transcript && !v.summary)).toBe(true);
  });

  it('a seat WITHOUT replay (policy NONE) gets neither the video nor the text — student and guest', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'NONE' });
    expect(await replayAllowed(c.buyer.user.id, c.w.session.id)).toBe(false);
    expect(await view(c.buyer.user.id, c.w.session.id)).toMatchObject({ transcript: false, summary: false });
    expect(await replayAllowed(c.guestUser.id, c.w.session.id)).toBe(false);
    expect(await view(c.guestUser.id, c.w.session.id)).toMatchObject({ transcript: false, summary: false });
    // The teacher still reads everything.
    expect(await view(c.w.teacher.id, c.w.session.id)).toMatchObject({ transcript: true, summary: true });
  });

  it('a replay window that closed (INCLUDED_DAYS 3, class 10 days ago) closes the text too; inside the window it is open', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_DAYS', replayDays: 3 });
    expect(await replayAllowed(c.buyer.user.id, c.w.session.id)).toBe(false);
    expect(await view(c.buyer.user.id, c.w.session.id)).toMatchObject({ transcript: false, summary: false });
    const open = await finishedClass({ replayPolicy: 'INCLUDED_DAYS', replayDays: 30 });
    expect(await view(open.buyer.user.id, open.w.session.id)).toMatchObject({ transcript: true, summary: true });
  });

  it('a student view carries no processing internals (meta, cost, job ids)', async () => {
    if (!guard()) return;
    const c = await finishedClass({ replayPolicy: 'INCLUDED_FOREVER' });
    const d: any = await S.live.sessionDetail(c.buyer.user.id, c.w.session.id);
    const json = JSON.stringify(d);
    console.log(`AUDIT student detail keys: ${Object.keys(d).join(',')} transcriptKeys=${Object.keys(d.transcript ?? {}).join(',')}`);
    expect(json).not.toMatch(/estUsd|jobId|gpt-4o|evidence/);
  });
});

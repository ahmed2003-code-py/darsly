import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { LiveAdmissionService } from './admission/live-admission.service';
import { assertLedgerBalanced, commerceStack, commerceWorld, fundWallet } from './commerce/testing';
import {
  classroom,
  classroomWorld,
  codeOf,
  confirmedGuest,
  type ClassroomWorld,
} from './testing/classroom';

/**
 * Live V1 Phase F on a real PostgreSQL: "طلب الانضمام". Capacity keeps its
 * one meaning (booking capacity). An approval is a one-person exception for
 * one class: a free class gets the seat at once; a paid class only lets that
 * student buy past the full check — never a seat without payment. Races run
 * against the same session row lock every seat takes.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveAdmissionRequest', 'liveBooking', 'livePurchase']);
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

const notes = () => ({ create: jest.fn(async () => ({})) });

/** A FREE class with its capacity exactly filled by the world's three booked students, plus two more students. */
async function fullFreeClass() {
  const w = await classroomWorld(prisma, { accessMode: 'FREE', capacity: 3 });
  const c = classroom(prisma);
  const n = notes();
  const admission = new LiveAdmissionService(prisma, c.live, c.realtime as never, n as never);
  const extra = [];
  for (let i = 0; i < 2; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `X${i} ${w.k}`, email: `adm${i}-${w.k}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    extra.push({ user: u, sp });
  }
  return { w, c, admission, notes: n, extra };
}
const bookingsOf = (w: ClassroomWorld) =>
  prisma.liveBooking.count({ where: { sessionId: w.ls.id } });

describe('FREE class, full', () => {
  it('ask → approve: a seat past the full capacity; capacity unchanged; the next student is still refused', async () => {
    if (!guard()) return;
    const { w, c, admission, notes: n, extra } = await fullFreeClass();
    const [A, B] = extra;
    expect(await codeOf(c.live.book(A.user.id, w.ls.id))).toBe('SESSION_FULL');
    const r = await admission.request(A.user.id, w.ls.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(n.create).toHaveBeenCalledTimes(1); // the teacher is told
    expect(c.events).toContainEqual(
      expect.objectContaining({ to: 'user', id: w.teacher.id, event: 'live:admissions' }),
    );
    // Not in the class before approval.
    expect(await codeOf(c.live.assertInSession(A.user.id, w.ls.id))).toBe(
      'You are not in this session',
    );
    const d = await admission.decide(w.teacher.id, w.ls.id, r!.id, 'APPROVE');
    expect(d).toMatchObject({ status: 'USED', alreadyDecided: false });
    expect((await c.live.assertInSession(A.user.id, w.ls.id)).role).toBe('STUDENT');
    expect(await bookingsOf(w)).toBe(4);
    const ls = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(ls.capacity).toBe(3);
    const detail = await c.live.teacherDetail(w.scope, w.ls.id);
    expect(detail.seats).toMatchObject({ capacity: 3, taken: 4, exceptions: 1 });
    // The exception was A's alone.
    expect(await codeOf(c.live.book(B.user.id, w.ls.id))).toBe('SESSION_FULL');
    expect(c.events).toContainEqual(
      expect.objectContaining({
        to: 'user',
        id: A.user.id,
        event: 'live:admission',
        payload: { sessionId: w.ls.id, status: 'USED' },
      }),
    );
  });

  it('only when full; asking twice is one request; a guest cannot ask; an outsider to a group class cannot ask', async () => {
    if (!guard()) return;
    const { w, admission, notes: n, extra } = await fullFreeClass();
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { capacity: 10 } });
    expect(await codeOf(admission.request(extra[0].user.id, w.ls.id))).toBe('NOT_FULL');
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { capacity: 3 } });
    const a = await admission.request(extra[0].user.id, w.ls.id);
    const b = await admission.request(extra[0].user.id, w.ls.id);
    expect(b!.id).toBe(a!.id);
    expect(n.create).toHaveBeenCalledTimes(1);
    expect(await prisma.liveAdmissionRequest.count({ where: { sessionId: w.ls.id } })).toBe(1);
    // Already seated: nothing to ask for.
    expect(await codeOf(admission.request(w.s[0].id, w.ls.id))).toBe('ALREADY_BOOKED');
    // A guest has no student profile.
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { capacity: 4 } });
    const g = await confirmedGuest(prisma, w, 'ضيف');
    expect(await codeOf(admission.request(g.id, w.ls.id))).toBe('ADMISSION_NOT_ELIGIBLE');
  });

  it('two teacher tabs approve at once: one seat, the second is told it was decided', async () => {
    if (!guard()) return;
    const { w, admission, extra } = await fullFreeClass();
    const r = await admission.request(extra[0].user.id, w.ls.id);
    const out = await Promise.all(
      [1, 2, 3].map(() => admission.decide(w.teacher.id, w.ls.id, r!.id, 'APPROVE')),
    );
    expect(out.filter((o) => !o.alreadyDecided)).toHaveLength(1);
    expect(out.every((o) => o.status === 'USED')).toBe(true);
    expect(
      await prisma.liveBooking.count({ where: { sessionId: w.ls.id, studentId: extra[0].sp.id } }),
    ).toBe(1);
  });

  it('reject → ask again only after the wait, and at most three times', async () => {
    if (!guard()) return;
    const { w, admission, extra } = await fullFreeClass();
    const u = extra[0].user.id;
    let r = await admission.request(u, w.ls.id);
    await admission.decide(w.teacher.id, w.ls.id, r!.id, 'REJECT');
    expect(await admission.mine(u, w.ls.id)).toMatchObject({ status: 'REJECTED' });
    expect(await codeOf(admission.request(u, w.ls.id))).toBe('ADMISSION_COOLDOWN');
    const past = () =>
      prisma.liveAdmissionRequest.update({
        where: { id: r!.id },
        data: { decidedAt: new Date(Date.now() - 10 * 60_000) },
      });
    await past();
    r = await admission.request(u, w.ls.id);
    expect(r).toMatchObject({ status: 'PENDING', attempts: 2 });
    await admission.decide(w.teacher.id, w.ls.id, r!.id, 'REJECT');
    await past();
    r = await admission.request(u, w.ls.id);
    expect(r!.attempts).toBe(3);
    await admission.decide(w.teacher.id, w.ls.id, r!.id, 'REJECT');
    await past();
    expect(await codeOf(admission.request(u, w.ls.id))).toBe('ADMISSION_LIMIT');
  });

  it('a seat opens while the request is pending: the student books normally and the request closes', async () => {
    if (!guard()) return;
    const { w, c, admission, extra } = await fullFreeClass();
    const r = await admission.request(extra[0].user.id, w.ls.id);
    await prisma.liveBooking.deleteMany({ where: { sessionId: w.ls.id, studentId: w.sp[2].id } });
    expect(await c.live.book(extra[0].user.id, w.ls.id)).toMatchObject({ ok: true });
    expect(await admission.mine(extra[0].user.id, w.ls.id)).toMatchObject({ status: 'CANCELLED' });
    // Approving it now changes nothing.
    expect(await admission.decide(w.teacher.id, w.ls.id, r!.id, 'APPROVE')).toMatchObject({
      status: 'CANCELLED',
      alreadyDecided: true,
    });
    expect(await bookingsOf(w)).toBe(3);
  });

  it('the class ends: pending requests expire, and nothing can be asked or approved', async () => {
    if (!guard()) return;
    const { w, c, admission, extra } = await fullFreeClass();
    const r = await admission.request(extra[0].user.id, w.ls.id);
    await c.live.endSession(w.ls.id, 'MANUAL');
    expect(await admission.mine(extra[0].user.id, w.ls.id)).toMatchObject({ status: 'EXPIRED' });
    expect(await admission.decide(w.teacher.id, w.ls.id, r!.id, 'APPROVE')).toMatchObject({
      status: 'EXPIRED',
      alreadyDecided: true,
    });
    expect(await codeOf(admission.request(extra[1].user.id, w.ls.id))).toBe('SESSION_ENDED');
  });

  it('only a moderator decides; the classroom panel lists open requests for moderators only', async () => {
    if (!guard()) return;
    const { w, c, admission, extra } = await fullFreeClass();
    const r = await admission.request(extra[0].user.id, w.ls.id);
    expect(await codeOf(admission.decide(w.assistant.id, w.ls.id, r!.id, 'APPROVE'))).toBe(
      'NOT_A_MODERATOR',
    );
    expect(await codeOf(admission.decide(w.s[0].id, w.ls.id, r!.id, 'APPROVE'))).toBe(
      'NOT_A_MODERATOR',
    );
    const st = await c.rtc.state(w.teacher.id, w.ls.id);
    expect(st.admissions).toMatchObject({
      capacity: 3,
      exceptions: 0,
      requests: [expect.objectContaining({ id: r!.id, status: 'PENDING' })],
    });
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).admissions).toBeUndefined();
  });
});

describe('PAID class, full: approval is never payment', () => {
  it('approved → still no seat and no way in; buying past the full check → paid from the wallet → seat; ledger balanced', async () => {
    if (!guard()) return;
    const S = commerceStack(prisma);
    const w = await commerceWorld(prisma, { students: 3, capacity: 1, priceCents: 10_000 });
    const [A, B, C] = w.students;
    const admission = new LiveAdmissionService(
      prisma,
      S.live,
      { emitToLive: () => undefined, emitToUser: () => undefined } as never,
      notes() as never,
    );
    // A holds the only seat.
    await S.commerce.hold(A.user.id, w.session.id);
    expect(await codeOf(S.commerce.hold(B.user.id, w.session.id))).toBe('SESSION_FULL');
    const r = await admission.request(B.user.id, w.session.id);
    // Only asked, not approved: still full for B.
    expect(await codeOf(S.commerce.hold(B.user.id, w.session.id))).toBe('SESSION_FULL');
    expect(await admission.decide(w.teacher.id, w.session.id, r!.id, 'APPROVE')).toMatchObject({
      status: 'APPROVED',
    });
    // Approved is not a seat: no booking, not in the class, and the free path stays shut.
    expect(
      await prisma.liveBooking.count({ where: { sessionId: w.session.id, studentId: B.sp.id } }),
    ).toBe(0);
    expect(await codeOf(S.live.assertInSession(B.user.id, w.session.id))).toBe(
      'You are not in this session',
    );
    expect(await codeOf(S.live.book(B.user.id, w.session.id))).toBe('PAID_SESSION_NEEDS_PURCHASE');
    // The ordinary purchase, past the full check — and paid.
    const before = await prisma.ledgerTransaction.count();
    await fundWallet(prisma, S.ledger, B.sp.id, 50_000);
    const paid = await S.commerce.payWithWallet(B.user.id, w.session.id);
    expect(paid).toMatchObject({ status: 'CONFIRMED' });
    expect(
      await prisma.liveBooking.count({ where: { sessionId: w.session.id, studentId: B.sp.id } }),
    ).toBe(1);
    const used = await prisma.liveAdmissionRequest.findUniqueOrThrow({ where: { id: r!.id } });
    expect(used).toMatchObject({ status: 'USED', purchaseId: paid.id });
    const txns = await prisma.ledgerTransaction.findMany({
      orderBy: { createdAt: 'asc' },
      skip: before,
      select: { id: true },
    });
    await assertLedgerBalanced(
      prisma,
      txns.map((t) => t.id),
    );
    // The exception was B's and is spent: C is refused, and so is B again.
    expect(await codeOf(S.commerce.hold(C.user.id, w.session.id))).toBe('SESSION_FULL');
    expect(await codeOf(admission.request(B.user.id, w.session.id))).toBe('ALREADY_BOOKED');
  });

  it('an approved student who pays by transfer: verification seats them (not OVERSOLD); another student cannot use it', async () => {
    if (!guard()) return;
    const S = commerceStack(prisma);
    const w = await commerceWorld(prisma, { students: 3, capacity: 1, priceCents: 10_000 });
    const [A, B, C] = w.students;
    const admission = new LiveAdmissionService(
      prisma,
      S.live,
      { emitToLive: () => undefined, emitToUser: () => undefined } as never,
      notes() as never,
    );
    await fundWallet(prisma, S.ledger, A.sp.id, 50_000);
    await S.commerce.payWithWallet(A.user.id, w.session.id); // the one seat, taken
    const r = await admission.request(B.user.id, w.session.id);
    await admission.decide(w.teacher.id, w.session.id, r!.id, 'APPROVE');
    const hold = await S.commerce.hold(B.user.id, w.session.id);
    expect(hold.status).toBe('HELD');
    // The transfer is declared, and the hold lapses before the money is
    // verified: payment verification must still seat them (not OVERSOLD).
    const phone = `010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const pend = await S.commerce.submitTransfer(B.user.id, hold.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    expect(pend.status).toBe('PAYMENT_PENDING');
    await prisma.livePurchase.update({
      where: { id: hold.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    const matched = await S.matching.ingest({
      provider: 'VODAFONE_CASH',
      amountCents: hold.studentPaysCents,
      reference: phone,
      externalId: randomUUID(),
      identities: [phone],
    });
    expect(matched.status).toBe('MATCHED');
    expect((await prisma.livePurchase.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      await prisma.liveAdmissionRequest.findUniqueOrThrow({ where: { id: r!.id } }),
    ).toMatchObject({ status: 'USED', purchaseId: hold.id });
    // C, never approved, cannot ride on B's exception.
    expect(await codeOf(S.commerce.hold(C.user.id, w.session.id))).toBe('SESSION_FULL');
  });

  it('race: a seat frees while the approval is being given — never more than one seat for the student', async () => {
    if (!guard()) return;
    const S = commerceStack(prisma);
    const w = await commerceWorld(prisma, { students: 2, capacity: 1, priceCents: 10_000 });
    const [A, B] = w.students;
    const admission = new LiveAdmissionService(
      prisma,
      S.live,
      { emitToLive: () => undefined, emitToUser: () => undefined } as never,
      notes() as never,
    );
    const a = await S.commerce.hold(A.user.id, w.session.id);
    const r = await admission.request(B.user.id, w.session.id);
    await Promise.all([
      admission.decide(w.teacher.id, w.session.id, r!.id, 'APPROVE'),
      prisma.livePurchase
        .update({ where: { id: a.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } })
        .then(() => S.commerce.expireHolds()),
    ]);
    const holds = await Promise.all([1, 2, 3].map(() => S.commerce.hold(B.user.id, w.session.id)));
    expect(new Set(holds.map((h) => h.id)).size).toBe(1);
    expect(
      await prisma.livePurchase.count({
        where: { sessionId: w.session.id, studentId: B.sp.id, status: 'HELD' },
      }),
    ).toBe(1);
  });
});

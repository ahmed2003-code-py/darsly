import { PrismaService } from '../../prisma/prisma.service';
import { accountBalance, commerceStack, commerceWorld, fundWallet } from './testing';

/**
 * Commerce D against a real PostgreSQL: cancellations and refunds — by the
 * policy frozen at purchase, never twice, always as a compensating ledger
 * transaction, and with the seat and the access gone the moment it is.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.livePurchase.count();
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

async function bought(opts: Parameters<typeof commerceWorld>[1] = {}) {
  const w = await commerceWorld(prisma, opts);
  const out = [];
  for (const s of w.students) {
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    out.push(await S.commerce.payWithWallet(s.user.id, w.session.id));
  }
  return { w, purchases: out };
}

describe('Commerce D on Postgres: a student cancels', () => {
  it('inside the window: the price back to the wallet (Darsly’s fee kept, as the terms say), seat and access gone', async () => {
    if (!guard()) return;
    const { w, purchases } = await bought({ refundPolicy: 'STANDARD', startsInMs: 3 * 86_400_000 });
    const s = w.students[0];
    const p = purchases[0];
    await expect(S.live.assertInSession(s.user.id, w.session.id)).resolves.toMatchObject({ role: 'STUDENT' });

    await Promise.allSettled([S.commerce.cancelByStudent(s.user.id, p.id), S.commerce.cancelByStudent(s.user.id, p.id)]);
    const after = await S.commerce.byId(p.id);
    expect(after.status).toBe('CANCELLED_BY_STUDENT');
    expect(after.refunds).toEqual([expect.objectContaining({ reason: 'STUDENT_CANCEL', amountCents: 10_000, status: 'COMPLETED' })]);
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(50_000 - 12_000 + 10_000);
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(0);
    await expect(S.live.assertInSession(s.user.id, w.session.id)).rejects.toThrow();
    // Darsly's 20 is still held, and is released to Darsly if the class is delivered.
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(2_000);
    // The seat is back in the pool: someone else can buy it.
    expect(await prisma.refund.count({ where: { livePurchaseId: p.id } })).toBe(1);
  });

  it('with a refundable fee, the whole amount comes back', async () => {
    if (!guard()) return;
    const w0 = await commerceWorld(prisma, { refundPolicy: 'FLEXIBLE', startsInMs: 5 * 3600_000 });
    await S.terms.createVersion(
      w0.academyId,
      { feeType: 'PERCENT', feeBps: 2000, feeMode: 'ADDITIVE', feeRefundableOnStudentCancel: true },
      w0.teacher.id,
    );
    const s = w0.students[0];
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    const p = await S.commerce.payWithWallet(s.user.id, w0.session.id);
    await S.commerce.cancelByStudent(s.user.id, p.id);
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(50_000);
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(0);
  });

  it('outside the window: nothing back, the seat released, and the money still owed to the seller', async () => {
    if (!guard()) return;
    const { w, purchases } = await bought({ refundPolicy: 'STRICT', startsInMs: 2 * 86_400_000 });
    const s = w.students[0];
    await S.commerce.cancelByStudent(s.user.id, purchases[0].id);
    const after = await S.commerce.byId(purchases[0].id);
    expect(after.status).toBe('CANCELLED_BY_STUDENT');
    expect(after.refunds).toEqual([]);
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(38_000);
    expect(await accountBalance(prisma, `purchase:${purchases[0].id}:held`)).toBe(12_000);
    expect((await S.commerce.pendingEarnings({ academyId: w.academyId }, 'teacher')).pendingCents).toBe(10_000);
  });

  it('NO_REFUND gives nothing back on the student’s own cancellation', async () => {
    if (!guard()) return;
    const { w, purchases } = await bought({ refundPolicy: 'NO_REFUND', startsInMs: 30 * 86_400_000 });
    await S.commerce.cancelByStudent(w.students[0].user.id, purchases[0].id);
    expect(await S.ledger.walletBalance(w.students[0].sp.id)).toBe(38_000);
  });

  it('refuses after the class started, and while a payment is being verified', async () => {
    if (!guard()) return;
    const { w, purchases } = await bought({ startsInMs: -10 * 60_000 });
    await expect(S.commerce.cancelByStudent(w.students[0].user.id, purchases[0].id)).rejects.toMatchObject({
      response: { code: 'CANCEL_WINDOW_CLOSED' },
    });
    const w2 = await commerceWorld(prisma);
    const u = w2.students[0].user.id;
    const h = await S.commerce.hold(u, w2.session.id);
    await S.commerce.submitTransfer(u, h.id, { method: 'VODAFONE_CASH', reference: '01099990000', proofImageUrl: 'data:x' });
    await expect(S.commerce.cancelByStudent(u, h.id)).rejects.toMatchObject({ response: { code: 'PAYMENT_UNDER_REVIEW' } });
    // Another student's purchase is not theirs to cancel.
    await expect(S.commerce.cancelByStudent(w.students[0].user.id, h.id)).rejects.toThrow('Purchase not found');
  });

  it('the free-booking cancel cannot take a paid seat without its refund', async () => {
    if (!guard()) return;
    const { w } = await bought();
    await expect(S.live.cancel(w.students[0].user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'PAID_CANCEL_VIA_PURCHASE' },
    });
  });
});

describe('Commerce D on Postgres: the teacher cancels', () => {
  it('every buyer gets everything back, access goes, nobody is paid — and a retry changes nothing', async () => {
    if (!guard()) return;
    const { w, purchases } = await bought({ students: 3, refundPolicy: 'STRICT', startsInMs: 2 * 86_400_000 });
    // One of them had already cancelled late (no refund then).
    await S.commerce.cancelByStudent(w.students[2].user.id, purchases[2].id);
    // A fourth only holds a seat.
    const extra = await commerceWorld(prisma);
    void extra;
    const scope = { academyId: w.academyId, userId: w.teacher.id, manageAll: true, role: 'OWNER' };
    const r = await S.live.remove(scope, w.session.id, w.teacher.id, 'ظرف طارئ');
    expect(r.deleted).toBe(true);
    for (const [i, s] of w.students.entries()) {
      expect(await S.ledger.walletBalance(s.sp.id)).toBe(50_000);
      const p = await prisma.livePurchase.findUniqueOrThrow({ where: { id: purchases[i].id } });
      expect(p.status).toBe(i === 2 ? 'CANCELLED_BY_STUDENT' : 'CANCELLED_BY_TEACHER');
      expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(0);
    }
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(0);
    // Retries: the cancellation again, and the sweep, twice at once.
    await S.commerce.onSessionCancelled(w.session.id, null);
    await Promise.all([S.commerce.sweepCancelled(), S.commerce.sweepCancelled()]);
    const refunds = await prisma.refund.findMany({ where: { livePurchase: { sessionId: w.session.id } } });
    expect(refunds).toHaveLength(3);
    expect(refunds.reduce((a, r) => a + r.amountCents, 0)).toBe(36_000);
    // And nothing is released for a cancelled class.
    await S.commerce.releaseDelivered();
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(0);
  });

  it('a held seat on a cancelled class is simply released', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const h = await S.commerce.hold(w.students[0].user.id, w.session.id);
    const scope = { academyId: w.academyId, userId: w.teacher.id, manageAll: true, role: 'OWNER' };
    await S.live.remove(scope, w.session.id, w.teacher.id);
    expect((await prisma.livePurchase.findUniqueOrThrow({ where: { id: h.id } })).status).toBe('CANCELLED_BY_TEACHER');
    expect(await prisma.refund.count({ where: { livePurchaseId: h.id } })).toBe(0);
  });
});

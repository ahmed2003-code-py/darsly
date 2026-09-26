import { PrismaService } from '../../prisma/prisma.service';
import { accountBalance, assertLedgerBalanced, commerceStack, commerceWorld, fundWallet } from './testing';

/**
 * Commerce C against a real PostgreSQL: held money becomes earnings exactly
 * once, only for a class the server itself says was delivered — and a class
 * that was not waits for a person.
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

/** A class that started `ranMin` minutes ago, with `n` wallet-bought seats. */
async function runningClass(opts: { ranMin: number; seats?: number; center?: { teacherSharePercent: number } | null }) {
  const w = await commerceWorld(prisma, {
    students: opts.seats ?? 1,
    startsInMs: -opts.ranMin * 60_000,
    durationMin: 60,
    center: opts.center ?? null,
  });
  const purchases = [];
  for (const s of w.students) {
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    purchases.push(await S.commerce.payWithWallet(s.user.id, w.session.id));
  }
  await prisma.liveSession.update({
    where: { id: w.session.id },
    data: { status: 'LIVE', startedAt: new Date(Date.now() - opts.ranMin * 60_000) },
  });
  return { w, purchases };
}

describe('Commerce C on Postgres: delivery and release', () => {
  it('a delivered class releases each seat once — to Darsly, the teacher, nobody else', async () => {
    if (!guard()) return;
    const { w, purchases } = await runningClass({ ranMin: 45, seats: 2 });
    const pendingBefore = await S.commerce.pendingEarnings({ academyId: w.academyId }, 'teacher');
    expect(pendingBefore).toEqual({ pendingCents: 20_000, pendingSeats: 2 });
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(0);

    // Ended through the server's own path (the teacher's end), not a flag.
    expect((await S.live.endSession(w.session.id, 'MANUAL')).outcome).toBe('ended');
    const [a, b] = await Promise.all([S.commerce.releaseDelivered(), S.commerce.releaseDelivered()]);
    expect(a.released + b.released).toBe(2);
    await S.commerce.releaseDelivered();

    for (const p of purchases) {
      expect((await S.commerce.byId(p.id)).status).toBe('DELIVERED');
      expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(0);
      expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `live-release:${p.id}` } })).toBe(1);
      const t = await prisma.ledgerTransaction.findFirstOrThrow({ where: { idempotencyKey: `live-release:${p.id}` } });
      await assertLedgerBalanced(prisma, [t.id]);
    }
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(20_000);
    expect(await S.commerce.pendingEarnings({ academyId: w.academyId }, 'teacher')).toEqual({
      pendingCents: 0,
      pendingSeats: 0,
    });
    // The whole journey balances: what the students paid is exactly what
    // Darsly and the teacher received, with nothing left in the holding accounts.
    const fee = await prisma.ledgerEntry.aggregate({
      where: { account: 'platform:commission', transaction: { idempotencyKey: { in: purchases.map((p) => `live-release:${p.id}`) } } },
      _sum: { amountCents: true },
    });
    expect(fee._sum.amountCents).toBe(4_000);
    const spent = await Promise.all(w.students.map((s) => S.ledger.walletBalance(s.sp.id)));
    expect(spent).toEqual([38_000, 38_000]);
  });

  it('a class that barely ran is not paid out by itself — it goes to review', async () => {
    if (!guard()) return;
    const { w, purchases } = await runningClass({ ranMin: 5 });
    await S.live.endSession(w.session.id, 'MANUAL');
    const r = await S.commerce.releaseDelivered();
    expect(r.review).toBeGreaterThanOrEqual(1);
    const p = await prisma.livePurchase.findUniqueOrThrow({ where: { id: purchases[0].id } });
    expect(p.status).toBe('NEEDS_REVIEW');
    expect(p.reviewReason).toMatch(/ran 5 of 60/);
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(0);
    // The seat is still theirs while it is reviewed (no access removed yet).
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);

    // Finance releases it — twice, at once; it moves once.
    await Promise.allSettled([S.commerce.adminRelease(p.id, 'admin'), S.commerce.adminRelease(p.id, 'admin')]);
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(10_000);
    expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: `live-release:${p.id}` } })).toBe(1);
  });

  it('a reviewed purchase refunded by finance: wallet back, seat gone, no release possible after', async () => {
    if (!guard()) return;
    const { w, purchases } = await runningClass({ ranMin: 5 });
    await S.live.endSession(w.session.id, 'MANUAL');
    await S.commerce.releaseDelivered();
    const id = purchases[0].id;
    await Promise.allSettled([S.commerce.adminRefund(id, 'admin'), S.commerce.adminRefund(id, 'admin')]);
    expect((await S.commerce.byId(id)).status).toBe('REFUNDED');
    expect(await S.ledger.walletBalance(w.students[0].sp.id)).toBe(50_000);
    expect(await prisma.refund.count({ where: { livePurchaseId: id } })).toBe(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: id } })).toBe(0);
    expect(await accountBalance(prisma, `purchase:${id}:held`)).toBe(0);
    await expect(S.commerce.adminRelease(id, 'admin')).rejects.toMatchObject({ response: { code: 'PURCHASE_STATE_CONFLICT' } });
    await S.commerce.releaseDelivered();
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(0);
  });

  it('a Center sale releases Darsly’s fee, the teacher’s share and the Center’s share from the snapshot', async () => {
    if (!guard()) return;
    const { w, purchases } = await runningClass({ ranMin: 50, center: { teacherSharePercent: 70 } });
    // Terms and split change AFTER the sale: the release must not care.
    await S.terms.createVersion(w.academyId, { feeType: 'PERCENT', feeBps: 5000, feeMode: 'DEDUCTED' }, w.teacher.id);
    await prisma.academy.update({ where: { id: w.academyId }, data: { teacherSharePercent: 10 } });
    await S.live.endSession(w.session.id, 'MANUAL');
    await S.commerce.releaseDelivered();
    const p = purchases[0];
    // 100 EGP at the platform default 20% additive: the student paid 120;
    // Darsly 20; net 100 split 70/30.
    expect(p.studentPaysCents).toBe(12_000);
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(7_000);
    expect(await accountBalance(prisma, `academy:${w.academyId}:balance`)).toBe(3_000);
    const t = await prisma.ledgerTransaction.findFirstOrThrow({
      where: { idempotencyKey: `live-release:${p.id}` },
      include: { entries: true },
    });
    const commission = t.entries.find((e) => e.account === 'platform:commission');
    expect(commission?.amountCents).toBe(2_000);
  });

  it('a class nobody started is flagged for review after its end, and nothing moves', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { startsInMs: -30 * 60_000, durationMin: 60 });
    await fundWallet(prisma, S.ledger, w.students[0].sp.id, 50_000);
    const p = await S.commerce.payWithWallet(w.students[0].user.id, w.session.id);
    // Move the class into the past (it never started).
    await prisma.liveSession.update({ where: { id: w.session.id }, data: { startsAt: new Date(Date.now() - 3 * 3600_000) } });
    await S.commerce.releaseDelivered();
    const after = await prisma.livePurchase.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'never started' });
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(12_000);
  });
});

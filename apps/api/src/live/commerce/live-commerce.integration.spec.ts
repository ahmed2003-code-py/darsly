import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  accountBalance,
  assertLedgerBalanced,
  commerceStack,
  commerceWorld,
  fundWallet,
} from './testing';

/**
 * Commerce B against a real PostgreSQL: seats, holds, the one payment
 * pipeline (proof → listener SMS → verification) and the wallet. What only a
 * database can prove is proved here — concurrent buyers against a row lock,
 * a partial unique index against a double click, a CAS against a replayed SMS.
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

let phoneSeq = Math.floor(Math.random() * 1e7);
const nextPhone = () => `010${String(++phoneSeq).padStart(8, '0')}`;

/** A listener SMS for this transfer, through the real ingestion path. */
const sms = (amountCents: number, reference: string, externalId = randomUUID()) =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    reference,
    externalId,
    identities: [reference],
  });

describe('Commerce B on Postgres: holding a seat', () => {
  it('five presses of "buy" make one purchase', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const res = await Promise.all(
      Array.from({ length: 5 }, () => S.commerce.hold(u, w.session.id)),
    );
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect(await prisma.livePurchase.count({ where: { sessionId: w.session.id } })).toBe(1);
    expect(res[0]).toMatchObject({ status: 'HELD', studentPaysCents: 12_000 });
  });

  it('capacity 1, twenty students at once: exactly one seat is held', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 20, capacity: 1 });
    const out = await Promise.allSettled(
      w.students.map((s) => S.commerce.hold(s.user.id, w.session.id)),
    );
    const won = out.filter((o) => o.status === 'fulfilled');
    const full = out.filter(
      (o) => o.status === 'rejected' && (o.reason as any)?.response?.code === 'SESSION_FULL',
    );
    expect(won).toHaveLength(1);
    expect(full).toHaveLength(19);
    expect(
      await prisma.livePurchase.count({ where: { sessionId: w.session.id, status: 'HELD' } }),
    ).toBe(1);
  });

  it('refuses the free-booking path for a paid session', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    await expect(S.live.book(w.students[0].user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'PAID_SESSION_NEEDS_PURCHASE' },
    });
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(0);
  });

  it('snapshots the price: changing terms or the session’s price later changes nothing already bought', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const p = await S.commerce.hold(w.students[0].user.id, w.session.id);
    await S.terms.createVersion(
      w.academyId,
      { feeType: 'PERCENT', feeBps: 5000, feeMode: 'DEDUCTED' },
      w.teacher.id,
    );
    await prisma.liveSession.update({ where: { id: w.session.id }, data: { priceCents: 99_900 } });
    const again = await prisma.livePurchase.findUniqueOrThrow({ where: { id: p.id } });
    expect(again).toMatchObject({
      studentPaysCents: 12_000,
      feeCents: 2_000,
      teacherCents: 10_000,
      feeMode: 'ADDITIVE',
    });
  });
});

describe('Commerce B on Postgres: transfer + listener', () => {
  it('proof → PENDING → the SMS matches → CONFIRMED with a booking; money held, nobody paid yet', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const p = await S.commerce.hold(u, w.session.id);
    const phone = nextPhone();
    const pending = await S.commerce.submitTransfer(u, p.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    expect(pending).toMatchObject({ status: 'PAYMENT_PENDING', payment: { status: 'PENDING' } });
    // A pending payment gives no seat.
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(0);

    const r = await sms(12_000, phone);
    expect(r.status).toBe('MATCHED');
    const done = await S.commerce.byId(p.id);
    expect(done).toMatchObject({ status: 'CONFIRMED', payment: { status: 'PAID' } });
    expect(
      await prisma.liveBooking.count({ where: { sessionId: w.session.id, purchaseId: p.id } }),
    ).toBe(1);
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(12_000);
    // Earnings are not withdrawable, and Darsly's fee is not taken, before delivery.
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(0);
    const pay = await prisma.payment.findUniqueOrThrow({
      where: { livePurchaseId: p.id },
      include: { ledgerTransaction: true },
    });
    expect(pay.courseId).toBeNull();
    expect(pay.ledgerTransaction?.idempotencyKey).toBe(`live-settle:${p.id}`);
    await assertLedgerBalanced(prisma, [pay.ledgerTransaction!.id]);
  });

  it('a replayed SMS, a wrong amount and a wrong reference do nothing', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const p = await S.commerce.hold(u, w.session.id);
    const phone = nextPhone();
    await S.commerce.submitTransfer(u, p.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    expect((await sms(11_999, phone)).status).not.toBe('MATCHED');
    expect((await sms(12_000, nextPhone())).status).not.toBe('MATCHED');
    expect((await S.commerce.byId(p.id)).status).toBe('PAYMENT_PENDING');
    const id = randomUUID();
    expect((await sms(12_000, phone, id)).status).toBe('MATCHED');
    expect((await sms(12_000, phone, id)).status).toBe('DUPLICATE');
    expect(
      await prisma.ledgerTransaction.count({ where: { idempotencyKey: `live-settle:${p.id}` } }),
    ).toBe(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
  });

  it('a teacher cannot verify (or reject) a paid seat for their own student; Darsly finance can reject', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const p = await S.commerce.hold(u, w.session.id);
    await S.commerce.submitTransfer(u, p.id, {
      method: 'VODAFONE_CASH',
      reference: nextPhone(),
      proofImageUrl: 'data:x',
    });
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    const teacher = { sub: w.teacher.id, role: 'TEACHER', tenantId: w.tp.id };
    await expect(S.manual.verify(teacher, pay.id)).rejects.toMatchObject({
      response: { code: 'LIVE_PAYMENT_ADMIN_ONLY' },
    });
    await expect(S.manual.reject(teacher, pay.id, 'x')).rejects.toMatchObject({
      response: { code: 'LIVE_PAYMENT_ADMIN_ONLY' },
    });
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(0);

    await S.manual.reject({ sub: 'admin', role: 'SUPER_ADMIN' }, pay.id, 'صورة غير واضحة');
    expect((await S.commerce.byId(p.id)).status).toBe('PAYMENT_REJECTED');
    // The seat is free again, and the student may buy afresh.
    const again = await S.commerce.hold(u, w.session.id);
    expect(again.id).not.toBe(p.id);
  });

  it('an admin verify gives the seat through the same path', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const p = await S.commerce.hold(u, w.session.id);
    await S.commerce.submitTransfer(u, p.id, {
      method: 'VODAFONE_CASH',
      reference: nextPhone(),
      proofImageUrl: 'data:x',
    });
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    const results = await Promise.allSettled([
      S.manual.verify({ sub: 'admin', role: 'SUPER_ADMIN' }, pay.id),
      S.manual.verify({ sub: 'admin', role: 'SUPER_ADMIN' }, pay.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
    expect(
      await prisma.ledgerTransaction.count({ where: { idempotencyKey: `live-settle:${p.id}` } }),
    ).toBe(1);
  });
});

describe('Commerce B on Postgres: holds, expiry and late money', () => {
  it('a lapsed hold goes back to the pool (and the sweep can run twice)', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 2, capacity: 1 });
    const a = await S.commerce.hold(w.students[0].user.id, w.session.id);
    await expect(S.commerce.hold(w.students[1].user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'SESSION_FULL' },
    });
    await prisma.livePurchase.update({
      where: { id: a.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await Promise.all([S.commerce.expireHolds(), S.commerce.expireHolds()]);
    expect((await S.commerce.byId(a.id)).status).toBe('EXPIRED');
    await expect(S.commerce.hold(w.students[1].user.id, w.session.id)).resolves.toMatchObject({
      status: 'HELD',
    });
  });

  it('money that arrives after the seat was taken is refunded in full, automatically (OVERSOLD)', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 2, capacity: 1 });
    const [A, B] = w.students;
    const a = await S.commerce.hold(A.user.id, w.session.id);
    await prisma.livePurchase.update({
      where: { id: a.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds();
    // B takes the seat from the wallet.
    await fundWallet(prisma, S.ledger, B.sp.id, 50_000);
    expect(await S.commerce.payWithWallet(B.user.id, w.session.id)).toMatchObject({
      status: 'CONFIRMED',
    });
    // A had transferred anyway and now sends the proof; the SMS arrives.
    const phone = nextPhone();
    const pend = await S.commerce.submitTransfer(A.user.id, a.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    expect(pend.status).toBe('PAYMENT_PENDING');
    expect((await sms(12_000, phone)).status).toBe('MATCHED');
    const after = await S.commerce.byId(a.id);
    expect(after.status).toBe('OVERSOLD');
    expect(after.refunds).toEqual([
      expect.objectContaining({ reason: 'OVERSOLD', status: 'COMPLETED', amountCents: 12_000 }),
    ]);
    expect(await S.ledger.walletBalance(A.sp.id)).toBe(12_000);
    expect(await accountBalance(prisma, `purchase:${a.id}:held`)).toBe(0);
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(1);
  });

  it('a lapsed hold whose money arrives while a seat is still free is simply confirmed', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { capacity: 5 });
    const u = w.students[0].user.id;
    const a = await S.commerce.hold(u, w.session.id);
    await prisma.livePurchase.update({
      where: { id: a.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds();
    const phone = nextPhone();
    await S.commerce.submitTransfer(u, a.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    await sms(12_000, phone);
    expect((await S.commerce.byId(a.id)).status).toBe('CONFIRMED');
  });

  it('the listener racing the expiry sweep never yields a seat AND an expiry', async () => {
    if (!guard()) return;
    for (let i = 0; i < 5; i++) {
      const w = await commerceWorld(prisma, { capacity: 1 });
      const u = w.students[0].user.id;
      const a = await S.commerce.hold(u, w.session.id);
      const phone = nextPhone();
      await S.commerce.submitTransfer(u, a.id, {
        method: 'VODAFONE_CASH',
        reference: phone,
        proofImageUrl: 'data:x',
      });
      await prisma.livePurchase.update({
        where: { id: a.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
      await Promise.all([S.commerce.expireHolds(), sms(12_000, phone)]);
      const end = await S.commerce.byId(a.id);
      const booked = await prisma.liveBooking.count({ where: { purchaseId: a.id } });
      // A submitted payment is never expired by the sweep; it ends CONFIRMED
      // (seat free) with its booking — never a booking without CONFIRMED.
      expect(end.status).toBe('CONFIRMED');
      expect(booked).toBe(1);
    }
  });

  it('money for a class the teacher has cancelled goes straight back', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const u = w.students[0].user.id;
    const a = await S.commerce.hold(u, w.session.id);
    const phone = nextPhone();
    await S.commerce.submitTransfer(u, a.id, {
      method: 'VODAFONE_CASH',
      reference: phone,
      proofImageUrl: 'data:x',
    });
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { cancelledAt: new Date(), deletedAt: new Date() },
    });
    await sms(12_000, phone);
    const end = await S.commerce.byId(a.id);
    expect(end.status).toBe('CANCELLED_BY_TEACHER');
    expect(await S.ledger.walletBalance(w.students[0].sp.id)).toBe(12_000);
    expect(await prisma.liveBooking.count({ where: { purchaseId: a.id } })).toBe(0);
  });
});

describe('Commerce B on Postgres: the wallet', () => {
  it('capacity 1, twenty funded buyers at once: one seat, one debit, nineteen untouched wallets', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 20, capacity: 1 });
    for (const s of w.students) await fundWallet(prisma, S.ledger, s.sp.id, 20_000);
    const out = await Promise.allSettled(
      w.students.map((s) => S.commerce.payWithWallet(s.user.id, w.session.id)),
    );
    const ok = out.filter(
      (o) => o.status === 'fulfilled' && (o.value as any).status === 'CONFIRMED',
    );
    expect(ok).toHaveLength(1);
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(1);
    const balances = await Promise.all(w.students.map((s) => S.ledger.walletBalance(s.sp.id)));
    expect(balances.filter((b) => b === 8_000)).toHaveLength(1);
    expect(balances.filter((b) => b === 20_000)).toHaveLength(19);
    for (const o of out.filter((x) => x.status === 'rejected')) {
      expect(['SESSION_FULL', 'WALLET_CONCURRENT_WRITE']).toContain(
        (o as any).reason?.response?.code,
      );
    }
  });

  it('five clicks of "pay from wallet" spend once', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const s = w.students[0];
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    await Promise.allSettled(
      Array.from({ length: 5 }, () => S.commerce.payWithWallet(s.user.id, w.session.id)),
    );
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(38_000);
    expect(
      await prisma.payment.count({
        where: { studentId: s.sp.id, livePurchaseId: { not: null }, status: 'PAID' },
      }),
    ).toBe(1);
  });

  it('not enough balance: no purchase, no seat, no debit', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const s = w.students[0];
    await fundWallet(prisma, S.ledger, s.sp.id, 11_999);
    await expect(S.commerce.payWithWallet(s.user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_BALANCE' },
    });
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(11_999);
    expect(await prisma.livePurchase.count({ where: { sessionId: w.session.id } })).toBe(0);
  });

  it('existing course purchases are untouched: a course bought from the wallet still enrols and credits the teacher', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const s = w.students[0];
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    const course = await prisma.course.create({
      data: {
        tenantId: w.tp.id,
        academyId: w.tp.id,
        title: 'كورس',
        status: 'PUBLISHED',
        priceCents: 10_000,
      },
    });
    const paid = await S.manual.payFromWallet(s.user.id, { courseId: course.id });
    expect(paid.status).toBe('PAID');
    const enr = await prisma.enrollment.findFirstOrThrow({
      where: { studentId: s.sp.id, courseId: course.id },
    });
    expect(enr.status).toBe('ACTIVE');
    const pay = await prisma.payment.findFirstOrThrow({ where: { courseId: course.id } });
    expect(pay.livePurchaseId).toBeNull();
    // The course path books straight to the teacher's balance, as it always has.
    expect(await accountBalance(prisma, `teacher:${w.tp.id}:balance`)).toBe(10_000);
  });
});

describe('Commerce B on Postgres: the Payment target', () => {
  it('the database refuses a payment with no target or two targets', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const base = {
      studentId: w.students[0].sp.id,
      tenantId: w.tp.id,
      amountCents: 100,
      status: 'PENDING' as const,
    };
    await expect(prisma.payment.create({ data: base })).rejects.toThrow();
    const p = await S.commerce.hold(w.students[0].user.id, w.session.id);
    const course = await prisma.course.create({
      data: { tenantId: w.tp.id, title: 'c', priceCents: 100 },
    });
    await expect(
      prisma.payment.create({ data: { ...base, courseId: course.id, livePurchaseId: p.id } }),
    ).rejects.toThrow();
  });
});

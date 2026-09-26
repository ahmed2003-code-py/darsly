import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponsService } from '../../enrollments/coupons.service';
import { accountBalance, commerceStack, commerceWorld, fundWallet } from './testing';

/**
 * Coupons on live seats, against a real PostgreSQL: an explicit scope (a
 * course coupon never discounts a seat), the discount frozen on the purchase,
 * usage limits under concurrency, and a 100%-off seat that stays PAID.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;
let coupons: CouponsService;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.coupon.count();
    S = commerceStack(prisma);
    coupons = new CouponsService(prisma);
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
const code = () => `LV${randomUUID().slice(0, 8).toUpperCase()}`;

describe('Live coupons on Postgres', () => {
  it('a course coupon (every coupon made before) never discounts a seat', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 50 });
    expect(c.scope).toBe('COURSE');
    await expect(S.commerce.hold(w.students[0].user.id, w.session.id, c.code)).rejects.toMatchObject({
      response: { code: 'COUPON_INVALID', reason: 'not-found' },
    });
  });

  it('a LIVE coupon: the discount comes off the price before the fee, and is frozen on the purchase', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 25, scope: 'LIVE' });
    const preview = await S.commerce.quote(w.session.id, w.students[0].user.id, c.code);
    expect(preview).toMatchObject({ studentPaysCents: 9_000, fullPriceCents: 12_000, discountCents: 2_500 });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(0);
    const p = await S.commerce.hold(w.students[0].user.id, w.session.id, c.code);
    expect(p.studentPaysCents).toBe(9_000);
    const row = await prisma.livePurchase.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ couponId: c.id, discountCents: 2_500, feeCents: 1_500, teacherCents: 7_500 });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(1);
  });

  it('a LIVE coupon never discounts a course; an ALL coupon discounts both', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const live = await coupons.create(w.tp.id, { code: code(), percentOff: 50, scope: 'LIVE' });
    const all = await coupons.create(w.tp.id, { code: code(), percentOff: 10, scope: 'ALL' });
    const course = await prisma.course.create({ data: { tenantId: w.tp.id, academyId: w.tp.id, title: 'c', status: 'PUBLISHED', priceCents: 10_000 } });
    expect((await S.manual.quote(course, live.code)).couponId).toBeNull();
    expect((await S.manual.quote(course, all.code)).couponId).toBe(all.id);
    await expect(S.commerce.hold(w.students[0].user.id, w.session.id, all.code)).resolves.toMatchObject({ studentPaysCents: 10_800 });
  });

  it('a coupon for another session, or an expired one, is refused with the reason', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 2 });
    const other = await prisma.liveSession.create({
      data: {
        tenantId: w.tp.id,
        academyId: w.academyId,
        teacherUserId: w.teacher.id,
        title: 'other',
        startsAt: new Date(Date.now() + 5 * 86_400_000),
        accessMode: 'PAID',
        priceCents: 5_000,
      },
    });
    const targeted = await coupons.create(w.tp.id, { code: code(), percentOff: 20, liveSessionId: other.id });
    expect(targeted.scope).toBe('LIVE');
    await expect(S.commerce.hold(w.students[0].user.id, w.session.id, targeted.code)).rejects.toMatchObject({
      response: { reason: 'other-session' },
    });
    const expired = await coupons.create(w.tp.id, { code: code(), percentOff: 20, scope: 'LIVE', expiresAt: new Date(Date.now() + 1000).toISOString() });
    await prisma.$executeRaw`UPDATE "Coupon" SET "expiresAt" = now() - interval '1 day' WHERE id = ${expired.id}`;
    await expect(S.commerce.hold(w.students[1].user.id, w.session.id, expired.code)).rejects.toMatchObject({
      response: { reason: 'expired' },
    });
  });

  it('one use left, five buyers at once: exactly one gets it', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 5 });
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 30, scope: 'LIVE', maxUses: 1 });
    const out = await Promise.allSettled(w.students.map((s) => S.commerce.hold(s.user.id, w.session.id, c.code)));
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(1);
  });

  it('per-student limit; a held seat that lapses gives its use back', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const s = w.students[0];
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 10, scope: 'LIVE', maxUsesPerStudent: 1 });
    const p = await S.commerce.hold(s.user.id, w.session.id, c.code);
    await prisma.livePurchase.update({ where: { id: p.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await S.commerce.expireHolds();
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(0);
    // It lapsed, so it was not "used": they may use it again, once.
    await fundWallet(prisma, S.ledger, s.sp.id, 50_000);
    await expect(S.commerce.payWithWallet(s.user.id, w.session.id, c.code)).resolves.toMatchObject({ status: 'CONFIRMED' });
    const w2 = await commerceWorld(prisma, { students: 0 });
    void w2;
    // A second seat on the same session with the same code: refused (per student).
    await expect(S.commerce.quote(w.session.id, s.user.id, c.code)).rejects.toMatchObject({ response: { reason: 'per-student' } });
  });

  it('100% off: a PAID seat confirmed at once — no payment, no ledger, still PAID', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 100, scope: 'LIVE' });
    const p = await S.commerce.hold(w.students[0].user.id, w.session.id, c.code);
    expect(p).toMatchObject({ status: 'CONFIRMED', studentPaysCents: 0 });
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { livePurchaseId: p.id } })).toBe(0);
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(0);
    expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: w.session.id } })).accessMode).toBe('PAID');
  });

  it('a discount that would leave less than a deducted fixed fee is refused as a coupon problem', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma);
    await S.terms.createVersion(w.academyId, { feeType: 'FIXED', feeFixedCents: 3_000, feeMode: 'DEDUCTED' }, w.teacher.id);
    const c = await coupons.create(w.tp.id, { code: code(), percentOff: 80, scope: 'LIVE' });
    await expect(S.commerce.hold(w.students[0].user.id, w.session.id, c.code)).rejects.toMatchObject({
      response: { code: 'COUPON_INVALID', reason: 'below-fee' },
    });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(0);
  });
});

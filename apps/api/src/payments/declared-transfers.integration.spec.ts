import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CouponsService } from '../enrollments/coupons.service';
import { commerceStack, commerceWorld } from '../live/commerce/testing';
import { UnmatchedTransfersService } from './unmatched-transfers.service';

/**
 * Course purchases and wallet top-ups on the Live payment flow, against a real
 * PostgreSQL: declare first (a durable PENDING row before any account is
 * shown), the listener confirms by itself, fulfilment happens exactly once —
 * under duplicate SMS, listener-vs-admin races and double requests — and two
 * targets of the same amount are never told apart by guessing.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;
let T: UnmatchedTransfersService;
let coupons: CouponsService;
let adminId: string;
const OURS = '01002589923';

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.walletTopup.count();
    S = commerceStack(prisma);
    T = new UnmatchedTransfersService(prisma);
    coupons = new CouponsService(prisma);
    adminId = (await prisma.user.create({ data: { role: 'SUPER_ADMIN', fullName: 'Finance', email: `dt-${randomUUID().slice(0, 8)}@it.test` } })).id;
    if (!(await prisma.platformPaymentAccount.findFirst({ where: { handle: OURS } }))) {
      await prisma.platformPaymentAccount.create({ data: { method: 'VODAFONE_CASH', label: 'فودافون كاش درسلي', handle: OURS } });
    }
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
const phone = () => `0112${String(++seq).padStart(7, '0')}`;
// An amount nobody else in this database uses (no stray candidate or transfer of it).
const price = () => 20_000 + 5 * Math.floor(Math.random() * 180_000);

const walletSms = (amountCents: number, sender: string, externalId = randomUUID()) =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    externalId,
    rawMessage: `تم استلام مبلغ ${(amountCents / 100).toFixed(2)} جنيه من ${sender} على رقم محفظتك ${OURS}. رقم العملية: 02${++seq}`,
  });
/** Into Darsly's wallet from a bank / InstaPay: a name and a transaction number, no sender number. */
const bankToWalletSms = (amountCents: number, payer: string) =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    externalId: randomUUID(),
    rawMessage: [`تم استلام مبلغ ${(amountCents / 100).toFixed(2)} جنيه`, `من ${payer} على`, `رقم محفظتك ${OURS} عن طريق انستاباي.`, `رقم العملية: 02${++seq}`].join('\n'),
  });

async function courseWorld(priceCents = price()) {
  const w = await commerceWorld(prisma, { students: 2 });
  const course = await prisma.course.create({
    data: { tenantId: w.tp.id, academyId: w.tp.id, title: `كورس ${w.k}`, status: 'PUBLISHED', priceCents },
  });
  return { ...w, course };
}
const declareCourse = (userId: string, courseId: string, extra: Record<string, unknown> = {}) =>
  S.manual.submit(userId, { courseId, method: 'VODAFONE_CASH', declare: true, source: 'WALLET', senderWallet: phone(), ...extra } as never);

describe('Course: declare, then the listener confirms it — once', () => {
  it('the PENDING payment exists before any instructions; nothing claimed, no proof', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const sender = phone();
    const p = await declareCourse(s.user.id, w.course.id, { senderWallet: sender });
    const st = await S.manual.statusFor(s.user.id, p.id);
    expect(st).toMatchObject({ status: 'PENDING', stage: 'AWAITING_TRANSFER', transferSource: 'WALLET', senderWallet: sender, claimedAt: null, enrollmentStatus: 'PENDING_PAYMENT' });
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.proofImageUrl ?? '').toBe('');
  });

  it('the SMS confirms it by itself: PAID, enrolled, ledger once — a duplicate SMS changes nothing', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const sender = phone();
    const p = await declareCourse(s.user.id, w.course.id, { senderWallet: sender });
    const ext = randomUUID();
    expect((await walletSms(p.amountCents, sender, ext)).status).toBe('MATCHED');
    expect((await walletSms(p.amountCents, sender, ext)).status).toBe('DUPLICATE');
    const st = await S.manual.statusFor(s.user.id, p.id);
    expect(st).toMatchObject({ status: 'PAID', stage: 'CONFIRMED', enrollmentStatus: 'ACTIVE' });
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: p.id } })).toBe(1);
    expect(await prisma.enrollment.count({ where: { studentId: s.sp.id, courseId: w.course.id } })).toBe(1);
  });

  it('bank / InstaPay → wallet: no wallet number, the full name confirms it', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const p = await S.manual.submit(s.user.id, {
      courseId: w.course.id, method: 'VODAFONE_CASH', declare: true, source: 'BANK', payerName: 'أحمد عبد العزيز هريدي',
    } as never);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).reference ?? '').toBe('');
    expect((await bankToWalletSms(p.amountCents, 'احمد عبدالعزيز هريدى')).status).toBe('MATCHED');
    expect((await S.manual.statusFor(s.user.id, p.id)).enrollmentStatus).toBe('ACTIVE');
  });

  it('listener and admin at the same instant: paid once, one ledger transaction, one enrolment', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const sender = phone();
    const p = await declareCourse(s.user.id, w.course.id, { senderWallet: sender });
    await Promise.allSettled([walletSms(p.amountCents, sender), S.manual.verifyByAdmin(adminId, p.id)]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PAID');
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: p.id } })).toBe(1);
    expect(await prisma.enrollment.count({ where: { studentId: s.sp.id, courseId: w.course.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('declaring twice returns the same payment; once the proof is sent it is closed to re-declaring', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const a = await declareCourse(s.user.id, w.course.id);
    const fixed = phone();
    const [b, c] = await Promise.all([
      declareCourse(s.user.id, w.course.id, { senderWallet: fixed }),
      declareCourse(s.user.id, w.course.id, { senderWallet: fixed }),
    ]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await prisma.payment.count({ where: { studentId: s.sp.id, courseId: w.course.id } })).toBe(1);
    await S.manual.attachProof(s.user.id, a.id, 'data:image/png;base64,iVBORw0KGgo=');
    expect((await S.manual.statusFor(s.user.id, a.id)).stage).toBe('PROOF_SENT');
    await expect(declareCourse(s.user.id, w.course.id)).rejects.toMatchObject({ response: { code: 'PAYMENT_PENDING' } });
  });

  it('already enrolled: a new declaration is refused', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const sender = phone();
    const p = await declareCourse(s.user.id, w.course.id, { senderWallet: sender });
    await walletSms(p.amountCents, sender);
    await expect(declareCourse(s.user.id, w.course.id)).rejects.toMatchObject({ response: { code: 'ALREADY_ENROLLED' } });
  });

  it('a coupon: its use is taken at declaration, kept on confirmation, given back if the declaration expires', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const c = await coupons.create(w.tp.id, { code: `CD${randomUUID().slice(0, 6).toUpperCase()}`, percentOff: 50, maxUses: 1 });
    const [s1, s2] = w.students;
    const p1 = await declareCourse(s1.user.id, w.course.id, { couponCode: c.code });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(1);
    // Abandoned: nobody transferred within the window.
    await prisma.payment.update({ where: { id: p1.id }, data: { createdAt: new Date(Date.now() - 80 * 3600_000) } });
    expect(await S.manual.expireDeclared(72 * 3600_000)).toBeGreaterThanOrEqual(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe('REJECTED');
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(0);
    // The released use is available again, and a confirmed purchase keeps it.
    const sender = phone();
    const p2 = await declareCourse(s2.user.id, w.course.id, { couponCode: c.code, senderWallet: sender });
    await walletSms(p2.amountCents, sender);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe('PAID');
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).usedCount).toBe(1);
  });

  it('expiry never touches a claimed (proof sent) or a matched payment', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const s = w.students[0];
    const p = await declareCourse(s.user.id, w.course.id);
    await S.manual.attachProof(s.user.id, p.id, 'data:image/png;base64,iVBORw0KGgo=');
    await prisma.payment.update({ where: { id: p.id }, data: { createdAt: new Date(Date.now() - 80 * 3600_000) } });
    await S.manual.expireDeclared(72 * 3600_000);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING');
  });

  it('two students, same course price, both declared by bank in names that both fit → nobody is guessed', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const [s1, s2] = w.students;
    const a = await S.manual.submit(s1.user.id, { courseId: w.course.id, method: 'VODAFONE_CASH', declare: true, source: 'BANK', payerName: 'أحمد عبد العزيز هريدي' } as never);
    const b = await S.manual.submit(s2.user.id, { courseId: w.course.id, method: 'VODAFONE_CASH', declare: true, source: 'BANK', payerName: 'أحمد عبد العزيز هريدي' } as never);
    expect((await bankToWalletSms(a.amountCents, 'احمد عبدالعزيز هريدى')).status).toBe('AMBIGUOUS');
    for (const p of [a, b]) expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING');
    expect((await S.manual.statusFor(s1.user.id, a.id)).stage).toBe('UNDER_REVIEW');
  });
});

describe('Wallet top-up: declare, then the listener credits it — exactly once', () => {
  const declareTopup = (userId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
    S.wallet.declareTopup(userId, { amountCents, method: 'VODAFONE_CASH', source: 'WALLET', senderWallet: phone(), ...extra } as never);

  it('the PENDING top-up exists before any instructions, with no proof', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const t = await declareTopup(s.user.id, price());
    expect(await S.wallet.topupStatus(s.user.id, t.id)).toMatchObject({ status: 'PENDING', stage: 'AWAITING_TRANSFER', claimedAt: null });
    expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).proofImageUrl).toBeNull();
  });

  it('the SMS credits it by itself; the same SMS again changes nothing', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const amount = price();
    const sender = phone();
    const before = await S.ledger.walletBalance(s.sp.id);
    const t = await declareTopup(s.user.id, amount, { senderWallet: sender });
    const ext = randomUUID();
    expect((await walletSms(amount, sender, ext)).status).toBe('MATCHED');
    expect((await walletSms(amount, sender, ext)).status).toBe('DUPLICATE');
    const st = await S.wallet.topupStatus(s.user.id, t.id);
    expect(st).toMatchObject({ status: 'APPROVED', stage: 'CONFIRMED', balanceCents: before + amount });
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(before + amount);
  });

  it('listener and admin at the same instant: the balance rises exactly once', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const amount = price();
    const sender = phone();
    const before = await S.ledger.walletBalance(s.sp.id);
    const t = await declareTopup(s.user.id, amount, { senderWallet: sender });
    await Promise.allSettled([walletSms(amount, sender), S.wallet.approveTopup(adminId, t.id), S.wallet.approveTopup(adminId, t.id)]);
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(before + amount);
    expect(await prisma.walletTransaction.count({ where: { studentId: s.sp.id, kind: 'TOPUP' } })).toBe(1);
  });

  it('a double declare request makes one top-up', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const amount = price();
    const [a, b] = await Promise.all([declareTopup(s.user.id, amount), declareTopup(s.user.id, amount)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.walletTopup.count({ where: { studentId: s.sp.id, status: 'PENDING' } })).toBe(1);
  });

  it('bank / InstaPay → wallet: the full name credits it', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const amount = price();
    const t = await S.wallet.declareTopup(s.user.id, { amountCents: amount, method: 'VODAFONE_CASH', source: 'BANK', payerName: 'منى محمد عبد الله' } as never);
    expect((await bankToWalletSms(amount, 'منى محمد عبدالله')).status).toBe('MATCHED');
    expect((await S.wallet.topupStatus(s.user.id, t.id)).status).toBe('APPROVED');
  });

  it('an abandoned declaration expires; nothing is credited', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const before = await S.ledger.walletBalance(s.sp.id);
    const t = await declareTopup(s.user.id, price());
    await prisma.walletTopup.update({ where: { id: t.id }, data: { createdAt: new Date(Date.now() - 80 * 3600_000) } });
    expect(await S.wallet.expireDeclaredTopups(72 * 3600_000)).toBeGreaterThanOrEqual(1);
    expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('REJECTED');
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(before);
  });

  it('finance ties an unmatched transfer to a top-up through the normal credit; a second tie is refused', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 1 });
    const s = w.students[0];
    const amount = price();
    const before = await S.ledger.walletBalance(s.sp.id);
    const t = await declareTopup(s.user.id, amount);
    // Paid from someone else's wallet (a parent's): the policy refuses to guess.
    const ev = await walletSms(amount, phone());
    expect(ev.status).toBe('AMBIGUOUS');
    const cands = await T.topupCandidates(ev.eventId!);
    expect(cands.map((c) => c.topupId)).toContain(t.id);
    await S.matching.manualMatchTopup(ev.eventId!, t.id, adminId, 'parent paid');
    await expect(S.matching.manualMatchTopup(ev.eventId!, t.id, adminId, 'again')).rejects.toMatchObject({ response: { code: 'EVENT_ALREADY_CLAIMED' } });
    expect(await S.ledger.walletBalance(s.sp.id)).toBe(before + amount);
  });
});

describe('Two targets of the same amount are never told apart by guessing', () => {
  it('a course and a top-up of one amount: the sender number decides; a bank transfer in a shared name goes to a person', async () => {
    if (!guard()) return;
    const w = await courseWorld();
    const [s1, s2] = w.students;
    const courseSender = phone();
    const p = await declareCourse(s1.user.id, w.course.id, { senderWallet: courseSender });
    const t = await S.wallet.declareTopup(s2.user.id, { amountCents: p.amountCents, method: 'VODAFONE_CASH', source: 'WALLET', senderWallet: phone() } as never);
    // The SMS names the course buyer's wallet: only the course is paid.
    expect((await walletSms(p.amountCents, courseSender)).status).toBe('MATCHED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PAID');
    expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('PENDING');
    // Now a transfer with no sender number at all, of the same amount: the top-up
    // is the only candidate left, but its student declared a wallet — the
    // name path needs a declared or account name that fits, and there is none.
    expect((await bankToWalletSms(p.amountCents, 'اسم غير معروف لحد')).status).not.toBe('MATCHED');
  });

  it('a Live seat and a course of one amount, both by bank in fitting names → manual review', async () => {
    if (!guard()) return;
    // A Live seat, and a course priced so its checkout total is exactly the seat's.
    const live = await commerceWorld(prisma, { students: 0, priceCents: price() });
    const { accessToken, purchase } = await S.commerce.guestHold(live.session.id, 'زائر');
    const w = await courseWorld(purchase.studentPaysCents);
    let lo = 1, hi = purchase.studentPaysCents;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const q = await S.manual.quote({ ...w.course, priceCents: mid }, undefined);
      if (q.totalCents < purchase.studentPaysCents) lo = mid + 1; else hi = mid;
    }
    await prisma.course.update({ where: { id: w.course.id }, data: { priceCents: lo } });
    const c = await S.manual.submit(w.students[0].user.id, { courseId: w.course.id, method: 'VODAFONE_CASH', declare: true, source: 'BANK', payerName: 'أحمد عبد العزيز هريدي' } as never);
    expect(c.amountCents).toBe(purchase.studentPaysCents);
    await S.commerce.guestDeclareTransfer(accessToken, { method: 'VODAFONE_CASH', source: 'BANK', payerName: 'أحمد عبد العزيز هريدي' });
    expect((await bankToWalletSms(purchase.studentPaysCents, 'احمد عبدالعزيز هريدى')).status).toBe('AMBIGUOUS');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PENDING');
    expect((await S.commerce.guestStatus(accessToken)).status).toBe('HELD');
  });
});

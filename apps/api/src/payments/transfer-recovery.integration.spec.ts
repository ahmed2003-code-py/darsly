import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { accountBalance, commerceStack, commerceWorld } from '../live/commerce/testing';
import { UnmatchedTransfersService } from './unmatched-transfers.service';

/**
 * Transfer evidence and recovery against a real PostgreSQL.
 *
 * The declare-before-transfer flow, the matcher on real rows, and every admin
 * recovery action (match, attach, return) — including the races a unit fake
 * cannot prove: one transfer, one use.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;
let T: UnmatchedTransfersService;
let adminId: string;
const OURS = '01002589923';

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.transferReturn.count();
    S = commerceStack(prisma);
    T = new UnmatchedTransfersService(prisma);
    const admin = await prisma.user.create({
      data: {
        role: 'SUPER_ADMIN',
        fullName: 'Finance',
        email: `fin-${randomUUID().slice(0, 8)}@it.test`,
      },
    });
    adminId = admin.id;
    // Darsly's receiving wallet, as production has it.
    if (!(await prisma.platformPaymentAccount.findFirst({ where: { handle: OURS } }))) {
      await prisma.platformPaymentAccount.create({
        data: { method: 'VODAFONE_CASH', label: 'فودافون كاش درسلي', handle: OURS },
      });
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
const phone = () => `0111${String(++seq).padStart(7, '0')}`;
// A price nobody else in this database uses, so no other test's pending
// payment or transfer of the same amount can take part.
const price = () => 20_000 + 5 * Math.floor(Math.random() * 180_000);

const walletSms = (amountCents: number, sender: string, payer = 'احمد عبدالعزيز هريدى') =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    externalId: randomUUID(),
    rawMessage: [
      `تم استلام مبلغ ${(amountCents / 100).toFixed(2)} جنيه من ${sender}؛`,
      `المسجل بإسم ${payer} على`,
      `على رقم محفظتك ${OURS}.`,
      `رقم العملية: 02${String(++seq).padStart(10, '0')}`,
    ].join('\n'),
  });

/** Money from a bank / InstaPay into our wallet: a name and a transaction number, no sender number. */
const bankToWalletSms = (amountCents: number, payer: string) =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    externalId: randomUUID(),
    rawMessage: [
      `تم استلام مبلغ ${(amountCents / 100).toFixed(2)} جنيه`,
      `من ${payer} على`,
      `رقم محفظتك ${OURS} عن طريق انستاباي.`,
      `رقم العملية: 02${String(++seq).padStart(10, '0')}`,
    ].join('\n'),
  });

async function heldStudent(opts: Parameters<typeof commerceWorld>[1] = {}) {
  const w = await commerceWorld(prisma, { priceCents: price(), ...opts });
  const student = w.students[0];
  const p = await S.commerce.hold(student.user.id, w.session.id);
  return { w, student, p };
}

describe('Payment before transfer: the durable candidate exists first', () => {
  it('declaring creates the PENDING payment while the seat stays HELD; the SMS then confirms it by sender number', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const sender = phone();
    const d = await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    expect(d.status).toBe('HELD');
    expect(d.payment).toMatchObject({
      status: 'PENDING',
      transferSource: 'WALLET',
      senderWallet: sender,
      claimedAt: null,
    });
    // (5) the provider-printed sender is the declared one.
    expect((await walletSms(p.studentPaysCents, sender)).status).toBe('MATCHED');
    const after = await S.commerce.byId(p.id);
    expect(after.status).toBe('CONFIRMED');
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(p.studentPaysCents);
    // The proof arriving after the SMS changes nothing and is not an error.
    await expect(
      S.commerce.submitTransfer(student.user.id, p.id, { proofImageUrl: 'data:x' }),
    ).resolves.toMatchObject({ status: 'CONFIRMED' });
  });

  it('a declaration can be corrected until claimed, and is refused with our own number', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    await expect(
      S.commerce.declareTransfer(student.user.id, p.id, {
        method: 'VODAFONE_CASH',
        source: 'WALLET',
        senderWallet: OURS,
      }),
    ).rejects.toMatchObject({ response: { code: 'OWN_NUMBER' } });
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: phone(),
    });
    const fixed = phone();
    const d = await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: fixed,
    });
    expect(d.payment!.senderWallet).toBe(fixed);
    expect(await prisma.payment.count({ where: { livePurchaseId: p.id } })).toBe(1);
    await S.commerce.submitTransfer(student.user.id, p.id, { proofImageUrl: 'data:x' });
    await expect(
      S.commerce.declareTransfer(student.user.id, p.id, {
        method: 'VODAFONE_CASH',
        source: 'WALLET',
        senderWallet: phone(),
      }),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_SUBMITTED' } });
    expect((await S.commerce.byId(p.id)).status).toBe('PAYMENT_PENDING');
  });

  it('(6) bank → wallet: no sender number is asked for; the full payer name confirms it when nothing else competes', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0, priceCents: price() });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'VODAFONE_CASH',
      source: 'BANK',
      payerName: 'أحمد عبد العزيز هريدي',
    });
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: purchase.id } });
    expect(pay).toMatchObject({
      transferSource: 'BANK',
      reference: '',
      payerName: 'أحمد عبد العزيز هريدي',
    });
    expect((await bankToWalletSms(purchase.studentPaysCents, 'احمد عبدالعزيز هريدى')).status).toBe(
      'MATCHED',
    );
    expect((await S.commerce.guestStatus(accessToken)).status).toBe('CONFIRMED');
  });

  it('(6/7) bank → wallet in another name → nobody is credited, the transfer waits for a person', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0, priceCents: price() });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'VODAFONE_CASH',
      source: 'BANK',
      payerName: 'سارة محمود حسن',
    });
    const r = await bankToWalletSms(purchase.studentPaysCents, 'احمد عبدالعزيز هريدى');
    expect(r.status).toBe('AMBIGUOUS');
    expect((await S.commerce.guestStatus(accessToken)).status).toBe('HELD');
  });

  it('(2) two buyers declared the same amount by bank → neither is guessed', async () => {
    if (!guard()) return;
    const amount = price();
    const w = await commerceWorld(prisma, { students: 0, priceCents: amount });
    const a = await S.commerce.guestHold(w.session.id, 'أحمد');
    const b = await S.commerce.guestHold(w.session.id, 'بسمة');
    for (const g of [a, b]) {
      await S.commerce.guestDeclareTransfer(g.accessToken, {
        method: 'VODAFONE_CASH',
        source: 'BANK',
        payerName: 'أحمد عبد العزيز هريدي',
      });
    }
    expect(
      (await bankToWalletSms(a.purchase.studentPaysCents, 'احمد عبدالعزيز هريدى')).status,
    ).toBe('AMBIGUOUS');
    expect((await S.commerce.guestStatus(a.accessToken)).status).toBe('HELD');
    expect((await S.commerce.guestStatus(b.accessToken)).status).toBe('HELD');
  });

  it('(9) SMS before the payment exists → UNMATCHED; declaring afterwards claims it once', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const sender = phone();
    const early = await walletSms(p.studentPaysCents, sender);
    expect(early.status).toBe('UNMATCHED');
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    expect((await S.commerce.byId(p.id)).status).toBe('CONFIRMED');
    const ev = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: early.eventId! } });
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    expect(ev).toMatchObject({ status: 'MATCHED', matchedPaymentId: pay.id });
    expect(await S.matching.reconcilePayment(pay.id)).toEqual({ status: 'SKIPPED' });
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: pay.id } })).toBe(1);
  });

  it('(10) SMS after the hold lapsed: a free seat is still given', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const sender = phone();
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    await prisma.livePurchase.update({
      where: { id: p.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds(100_000);
    expect((await S.commerce.byId(p.id)).status).toBe('EXPIRED');
    expect((await walletSms(p.studentPaysCents, sender)).status).toBe('MATCHED');
    expect((await S.commerce.byId(p.id)).status).toBe('CONFIRMED');
  });

  it('(10) SMS after the hold lapsed and the class filled: refunded, no seat', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), capacity: 1, students: 2 });
    const [a, b] = w.students;
    const pa = await S.commerce.hold(a.user.id, w.session.id);
    const sender = phone();
    await S.commerce.declareTransfer(a.user.id, pa.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    await prisma.livePurchase.update({
      where: { id: pa.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds(100_000);
    // Someone else takes the only seat.
    const pb = await S.commerce.hold(b.user.id, w.session.id);
    const sb = phone();
    await S.commerce.declareTransfer(b.user.id, pb.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sb,
    });
    expect((await walletSms(pb.studentPaysCents, sb)).status).toBe('MATCHED');
    // A's money lands late.
    expect((await walletSms(pa.studentPaysCents, sender)).status).toBe('MATCHED');
    const late = await S.commerce.byId(pa.id);
    expect(late.status).toBe('OVERSOLD');
    expect(late.refunds).toHaveLength(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: pa.id } })).toBe(0);
    expect(await prisma.liveBooking.count({ where: { sessionId: w.session.id } })).toBe(1);
  });

  it('paying from the wallet after declaring a transfer is refused (no double charge)', async () => {
    if (!guard()) return;
    const { student, p, w } = await heldStudent();
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: phone(),
    });
    await S.ledger.creditWallet(student.sp.id, p.studentPaysCents * 2, 'test top-up');
    await expect(S.commerce.payWithWallet(student.user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'TRANSFER_ALREADY_STARTED' },
    });
  });
});

describe('Admin recovery of transfers the matcher would not take', () => {
  it('(A, B) match to an existing pending payment: confirmed once, a double click cannot spend it twice', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: phone(),
    });
    await S.commerce.submitTransfer(student.user.id, p.id, { proofImageUrl: 'data:x' });
    // The transfer came from another wallet (a parent's): the policy refuses it.
    const ev = await walletSms(p.studentPaysCents, phone());
    expect(ev.status).toBe('AMBIGUOUS');
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    const results = await Promise.allSettled([
      S.matching.manualMatch(ev.eventId!, pay.id, adminId, 'parent paid'),
      S.matching.manualMatch(ev.eventId!, pay.id, adminId, 'parent paid'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await S.commerce.byId(p.id)).status).toBe('CONFIRMED');
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: pay.id } })).toBe(1);
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(p.studentPaysCents);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).verifiedById).toBe(
      adminId,
    );
  });

  it('(C) attach to a Live purchase that never got a payment: verified normally, exactly once', async () => {
    if (!guard()) return;
    const { p } = await heldStudent();
    const ev = await bankToWalletSms(p.studentPaysCents, 'سارة محمود حسن');
    expect(ev.status).toBe('UNMATCHED');
    const candidates = await S.commerce.recoveryCandidates(p.studentPaysCents);
    expect(candidates.map((c) => c.purchaseId)).toContain(p.id);
    const first = await S.commerce.adminAttachTransfer(
      ev.eventId!,
      p.id,
      adminId,
      'buyer form failed',
    );
    expect(first).toMatchObject({ status: 'CONFIRMED', already: false });
    const again = await S.commerce.adminAttachTransfer(
      ev.eventId!,
      p.id,
      adminId,
      'buyer form failed',
    );
    expect(again.already).toBe(true);
    expect(await prisma.payment.count({ where: { livePurchaseId: p.id } })).toBe(1);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: pay.id } })).toBe(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'live.transfer.attach', entityId: p.id } }),
    ).toBe(1);
  });

  it('(C) two admins attaching at once: one payment, one verification', async () => {
    if (!guard()) return;
    const { p } = await heldStudent();
    const ev = await bankToWalletSms(p.studentPaysCents, 'سارة محمود حسن');
    await Promise.allSettled([
      S.commerce.adminAttachTransfer(ev.eventId!, p.id, adminId, 'race'),
      S.commerce.adminAttachTransfer(ev.eventId!, p.id, adminId, 'race'),
    ]);
    expect(await prisma.payment.count({ where: { livePurchaseId: p.id } })).toBe(1);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: p.id } });
    expect(pay.status).toBe('PAID');
    expect(await prisma.ledgerTransaction.count({ where: { paymentId: pay.id } })).toBe(1);
  });

  it('(D) wrong amount → refused, nothing written', async () => {
    if (!guard()) return;
    const { p } = await heldStudent();
    const ev = await bankToWalletSms(p.studentPaysCents + 100, 'سارة محمود حسن');
    await expect(
      S.commerce.adminAttachTransfer(ev.eventId!, p.id, adminId, 'x y z'),
    ).rejects.toMatchObject({
      response: { code: 'AMOUNT_MISMATCH' },
    });
    expect(await prisma.payment.count({ where: { livePurchaseId: p.id } })).toBe(0);
  });

  it('(E) an event already claimed is refused by attach, match and return', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const sender = phone();
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    const ev = await walletSms(p.studentPaysCents, sender);
    expect(ev.status).toBe('MATCHED');
    const other = await heldStudent();
    await expect(
      S.commerce.adminAttachTransfer(ev.eventId!, other.p.id, adminId, 'x y z'),
    ).rejects.toMatchObject({
      response: { code: 'EVENT_ALREADY_CLAIMED' },
    });
    await expect(
      T.requestReturn(ev.eventId!, adminId, {
        method: 'VODAFONE_CASH',
        holderName: 'Someone',
        handle: phone(),
        reason: 'mistake',
      }),
    ).rejects.toMatchObject({ response: { code: 'EVENT_ALREADY_CLAIMED' } });
  });

  it('(F) a class already over: the attached money is refunded, no seat, no attendance', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, {
      priceCents: price(),
      startsInMs: -3 * 3600_000,
      durationMin: 5,
    });
    // A purchase made while it was open (as the 27 Sep test was), now EXPIRED.
    const student = w.students[0];
    const pre = await prisma.livePurchase.findFirst({ where: { sessionId: w.session.id } });
    expect(pre).toBeNull();
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { startsAt: new Date(Date.now() + 3600_000) },
    });
    const p = await S.commerce.hold(student.user.id, w.session.id);
    await prisma.livePurchase.update({
      where: { id: p.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds(100_000);
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { startsAt: new Date(Date.now() - 3 * 3600_000) },
    });
    const ev = await bankToWalletSms(p.studentPaysCents, 'سارة محمود حسن');
    const out = await S.commerce.adminAttachTransfer(ev.eventId!, p.id, adminId, 'late transfer');
    expect(out.status).toBe('OVERSOLD');
    expect(out.refunds).toHaveLength(1);
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(0);
    // The student's money is back in their wallet, nothing kept, nothing released.
    expect(await accountBalance(prisma, `purchase:${p.id}:held`)).toBe(0);
  });

  it('(F) the 27 Sep shape: a guest, EXPIRED, no payment, class over → attach gives a manual refund owed, never access', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, {
      students: 0,
      priceCents: price(),
      startsInMs: 3600_000,
      durationMin: 5,
    });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر');
    await prisma.livePurchase.update({
      where: { id: purchase.id },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    await S.commerce.expireHolds(100_000);
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { startsAt: new Date(Date.now() - 3600_000) },
    });
    const ev = await bankToWalletSms(purchase.studentPaysCents, 'سارة محمود حسن');
    await S.commerce.adminAttachTransfer(
      ev.eventId!,
      purchase.id,
      adminId,
      'guest paid after the class',
    );
    const s = await S.commerce.guestStatus(accessToken);
    expect(s.status).toBe('OVERSOLD');
    expect(s.canEnter).toBe(false);
    expect(s.refunds[0]).toMatchObject({ status: 'REQUESTED', needsDestination: true });
    await expect(S.commerce.guestClassroomToken(accessToken)).rejects.toMatchObject({
      response: { code: 'SEAT_NOT_ACTIVE' },
    });
  });

  it('(G, H) a manual return: requested → approved → completed; the event can then never be matched or attached', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const ev = await bankToWalletSms(p.studentPaysCents, 'سارة محمود حسن');
    const ledgerBefore = await prisma.ledgerEntry.count();
    const r = await T.requestReturn(ev.eventId!, adminId, {
      method: 'VODAFONE_CASH',
      holderName: 'سارة محمود',
      handle: phone(),
      reason: 'no purchase for this money',
    });
    expect(r).toMatchObject({ status: 'REQUESTED', amountCents: p.studentPaysCents });
    await expect(T.completeReturn(r.id, adminId, 'TX-1')).rejects.toMatchObject({
      response: { code: 'RETURN_STATE_CONFLICT' },
    });
    await T.approveReturn(r.id, adminId);
    const done = await T.completeReturn(r.id, adminId, 'VF-RET-123');
    expect(done).toMatchObject({ status: 'COMPLETED', transferReference: 'VF-RET-123' });
    // A second press changes nothing.
    expect((await T.completeReturn(r.id, adminId, 'VF-RET-999')).transferReference).toBe(
      'VF-RET-123',
    );
    expect(
      (await prisma.paymentEvent.findUniqueOrThrow({ where: { id: ev.eventId! } })).status,
    ).toBe('RETURNED');
    // Money that never entered the books leaves no trace in them.
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);
    await expect(
      S.commerce.adminAttachTransfer(ev.eventId!, p.id, adminId, 'x y z'),
    ).rejects.toMatchObject({
      response: { code: 'EVENT_ALREADY_CLAIMED' },
    });
    const pay = await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'BANK',
      payerName: 'سارة محمود حسن',
    });
    await expect(
      S.matching.manualMatch(ev.eventId!, pay.payment!.id, adminId),
    ).rejects.toMatchObject({
      response: { code: 'EVENT_RETURNED' },
    });
    // Nor does the automatic matcher take it.
    expect((await S.commerce.byId(p.id)).status).toBe('HELD');
  });

  it('(I) a matched event cannot be returned; a cancelled return reopens the event', async () => {
    if (!guard()) return;
    const { student, p } = await heldStudent();
    const sender = phone();
    await S.commerce.declareTransfer(student.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: sender,
    });
    const matched = await walletSms(p.studentPaysCents, sender);
    await expect(
      T.requestReturn(matched.eventId!, adminId, {
        method: 'VODAFONE_CASH',
        holderName: 'X Y',
        handle: phone(),
        reason: 'not ours',
      }),
    ).rejects.toMatchObject({ response: { code: 'EVENT_ALREADY_CLAIMED' } });

    const loose = await bankToWalletSms(price(), 'سارة محمود حسن');
    const r = await T.requestReturn(loose.eventId!, adminId, {
      method: 'VODAFONE_CASH',
      holderName: 'X Y',
      handle: phone(),
      reason: 'unknown sender',
    });
    await T.cancelReturn(r.id, adminId, 'found the buyer');
    expect(
      (await prisma.paymentEvent.findUniqueOrThrow({ where: { id: loose.eventId! } })).status,
    ).toBe('UNMATCHED');
    // …and can be returned again later (the same row, reopened).
    const again = await T.requestReturn(loose.eventId!, adminId, {
      method: 'VODAFONE_CASH',
      holderName: 'X Y',
      handle: phone(),
      reason: 'really unknown',
    });
    expect(again.id).toBe(r.id);
    expect(again.status).toBe('REQUESTED');
  });

  it('(27 Sep "test the money") a transfer whose payment an admin already confirmed by hand is linked, never returned, and nothing moves', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0, priceCents: price() });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: phone(),
    });
    await S.commerce.guestSubmitTransfer(accessToken, { proofImageUrl: 'data:x' });
    // The money came through a bank (another rail): nothing to match automatically.
    const ev = await S.matching.ingest({
      provider: 'BANK_TRANSFER',
      amountCents: purchase.studentPaysCents,
      externalId: randomUUID(),
      rawMessage: `تم تنفيذ تحويل لحظي بمبلغ ${(purchase.studentPaysCents / 100).toFixed(2)} جم إلى حسابك برقم مرجعي ${randomUUID().slice(0, 8)}`,
    });
    expect(ev.status).toBe('UNMATCHED');
    const pay = await prisma.payment.findUniqueOrThrow({ where: { livePurchaseId: purchase.id } });
    // Linking to a payment not yet confirmed is refused — that is what match is for.
    await expect(
      S.matching.linkToVerified(ev.eventId!, pay.id, adminId, 'same money'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_VERIFIED' },
    });
    await S.manual.verifyByAdmin(adminId, pay.id);
    const ledgerBefore = await prisma.ledgerEntry.count();
    const verified = await T.verifiedCandidates(ev.eventId!);
    expect(verified.map((v) => v.paymentId)).toContain(pay.id);
    await S.matching.linkToVerified(
      ev.eventId!,
      pay.id,
      adminId,
      'admin confirmed this transfer by hand at 07:45',
    );
    expect(
      await prisma.paymentEvent.findUniqueOrThrow({ where: { id: ev.eventId! } }),
    ).toMatchObject({ status: 'MATCHED', matchedPaymentId: pay.id });
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);
    expect((await S.commerce.guestStatus(accessToken)).status).toBe('CONFIRMED');
    // Spent: it can no longer be returned, and the payment takes no second transfer.
    await expect(
      T.requestReturn(ev.eventId!, adminId, {
        method: 'VODAFONE_CASH',
        holderName: 'X Y',
        handle: phone(),
        reason: 'mistake',
      }),
    ).rejects.toMatchObject({ response: { code: 'EVENT_ALREADY_CLAIMED' } });
    const other = await bankToWalletSms(purchase.studentPaysCents, 'سارة محمود حسن');
    await expect(
      S.matching.linkToVerified(other.eventId!, pay.id, adminId, 'again'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_HAS_TRANSFER' },
    });
    expect((await T.verifiedCandidates(other.eventId!)).map((v) => v.paymentId)).not.toContain(
      pay.id,
    );
  });

  it('the admin list is masked: no raw SMS, only the tail of the reference', async () => {
    if (!guard()) return;
    const ev = await bankToWalletSms(price(), 'سارة محمود حسن');
    const rows = await T.list('OPEN');
    const row = rows.find((r) => r.id === ev.eventId);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('تم استلام');
    expect(row!.receivingAccount?.label).toBe('فودافون كاش درسلي');
    expect(row!.payerName).toBe('سارة محمود حسن');
  });
});

import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { accountBalance, commerceStack, commerceWorld } from './testing';

/**
 * The Live completion pass against a real PostgreSQL: free sessions shared by
 * link (registered students and guests), the edit policy by state and
 * commitment, the listener completing a paid seat with no second action, and
 * the buyer's payment stage.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;
const OURS = '01002589923';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret-for-guest-tokens-0123456789';

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.transferReturn.count();
    S = commerceStack(prisma);
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

const price = () => 20_000 + 5 * Math.floor(Math.random() * 180_000);
const scopeOf = (w: Awaited<ReturnType<typeof commerceWorld>>) =>
  ({ academyId: w.academyId, userId: w.teacher.id, manageAll: true, role: 'OWNER' }) as never;

/** A FREE, academy-wide session (commerceWorld makes PAID ones). */
async function freeWorld(opts: Parameters<typeof commerceWorld>[1] = {}) {
  const w = await commerceWorld(prisma, opts);
  await prisma.liveSession.update({
    where: { id: w.session.id },
    data: { accessMode: 'FREE', priceCents: null },
  });
  return w;
}

describe('A FREE session shared by its link', () => {
  it('is public: title, teacher, time, state and FREE — no price', async () => {
    if (!guard()) return;
    const w = await freeWorld();
    const o = await S.commerce.publicOffer(w.session.id);
    expect(o).toMatchObject({
      id: w.session.id,
      accessMode: 'FREE',
      studentPaysCents: 0,
      live: false,
      closed: false,
    });
    expect(o.teacherName).toBeTruthy();
    expect(new Date(o.joinOpensAt).getTime()).toBe(w.session.startsAt.getTime() - 15 * 60_000);
  });

  it('a logged-out guest takes a free seat: confirmed at once, zero amounts, no payment, no ledger', async () => {
    if (!guard()) return;
    const w = await freeWorld();
    const ledger = await prisma.ledgerEntry.count();
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'زائر الحصة');
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(purchase.status).toBe('CONFIRMED');
    const row = await prisma.livePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { payment: true },
    });
    expect(row).toMatchObject({
      basePriceCents: 0,
      studentPaysCents: 0,
      feeCents: 0,
      teacherCents: 0,
      centerCents: 0,
    });
    expect(row.payment).toBeNull();
    expect(await prisma.ledgerEntry.count()).toBe(ledger);
    const status = await S.commerce.guestStatus(accessToken);
    expect(status).toMatchObject({ status: 'CONFIRMED', free: true, paymentStage: 'NONE' });
    expect(status.session.accessMode).toBe('FREE');
  });

  it('a free guest seat counts against capacity; a full class refuses the next guest and student', async () => {
    if (!guard()) return;
    const w = await freeWorld({ capacity: 1, students: 1 });
    await S.commerce.guestHold(w.session.id, 'أول ضيف');
    await expect(S.commerce.guestHold(w.session.id, 'ثاني ضيف')).rejects.toMatchObject({
      response: { code: 'SESSION_FULL' },
    });
    await expect(S.live.book(w.students[0].user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'SESSION_FULL' },
    });
  });

  it('a free guest gets a token for this one classroom only, and never a student’s rights', async () => {
    if (!guard()) return;
    const w = await freeWorld();
    const other = await freeWorld();
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'ضيف');
    const t = await S.commerce.guestClassroomToken(accessToken);
    expect(t.liveSessionId).toBe(w.session.id);
    expect(t.user.role).toBe('GUEST');
    await expect(S.live.assertInSession(t.user.id, other.session.id)).rejects.toThrow();
    // No student profile, so nothing a student can do (book, enroll, buy).
    expect(await prisma.studentProfile.findUnique({ where: { userId: t.user.id } })).toBeNull();
    await expect(S.live.book(t.user.id, other.session.id)).rejects.toThrow();
  });

  it('a registered student not enrolled with the academy can book it from the link', async () => {
    if (!guard()) return;
    const w = await freeWorld({ students: 1 });
    const sid = w.students[0].user.id;
    const before = await S.live.myAccess(sid, w.session.id);
    expect(before).toMatchObject({ booked: false, canBook: true, accessMode: 'FREE' });
    await S.live.book(sid, w.session.id);
    expect(await S.live.myAccess(sid, w.session.id)).toMatchObject({
      booked: true,
      canBook: false,
    });
    // …and it now appears in their Live list.
    const list = await S.live.upcomingForStudent(sid);
    expect(list.map((s: { id: string }) => s.id)).toContain(w.session.id);
  });

  it('a group’s free class is never public and never bookable by outsiders', async () => {
    if (!guard()) return;
    const w = await freeWorld({ students: 1 });
    const g = await prisma.group.create({
      data: { academyId: w.academyId, name: `G ${randomUUID().slice(0, 4)}` } as never,
    });
    await prisma.liveSession.update({ where: { id: w.session.id }, data: { groupId: g.id } });
    await expect(S.commerce.publicOffer(w.session.id)).rejects.toThrow();
    await expect(S.commerce.guestHold(w.session.id, 'ضيف')).rejects.toThrow();
    await expect(S.live.book(w.students[0].user.id, w.session.id)).rejects.toThrow();
  });

  it('cancelled, deleted or ended: no page, no seat', async () => {
    if (!guard()) return;
    const ended = await freeWorld({ students: 1, startsInMs: -3 * 3600_000, durationMin: 30 });
    await expect(S.commerce.guestHold(ended.session.id, 'ضيف')).rejects.toMatchObject({
      response: { code: 'SESSION_ENDED' },
    });
    await expect(S.live.book(ended.students[0].user.id, ended.session.id)).rejects.toMatchObject({
      response: { code: 'SESSION_ENDED' },
    });
    expect((await S.commerce.publicOffer(ended.session.id)).closed).toBe(true);
    const cancelled = await freeWorld();
    await S.live.remove(scopeOf(cancelled), cancelled.session.id, cancelled.teacher.id);
    await expect(S.commerce.publicOffer(cancelled.session.id)).rejects.toThrow();
    await expect(S.commerce.guestHold(cancelled.session.id, 'ضيف')).rejects.toThrow();
    await expect(S.commerce.publicOffer(randomUUID())).rejects.toThrow();
  });

  it('before the start the guest cannot enter; the join refusal carries the session for the lobby', async () => {
    if (!guard()) return;
    const w = await freeWorld();
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'ضيف');
    expect((await S.commerce.guestStatus(accessToken)).canEnter).toBe(false);
    const t = await S.commerce.guestClassroomToken(accessToken);
    const err = await S.live.join(t.user.id, w.session.id).catch((e) => e);
    expect(err.getResponse()).toMatchObject({
      code: 'NOT_OPEN_YET',
      session: { id: w.session.id, title: w.session.title },
    });
  });

  it('the teacher sees guest seats in the count and the attendee list', async () => {
    if (!guard()) return;
    const w = await freeWorld({ students: 1 });
    await S.live.book(w.students[0].user.id, w.session.id);
    await S.commerce.guestHold(w.session.id, 'ضيفة');
    const list = await S.live.listForTeacher(scopeOf(w));
    expect(list.find((x: { id: string }) => x.id === w.session.id)?.bookedCount).toBe(2);
    const people = await S.live.bookingsFor(scopeOf(w), w.session.id);
    expect(people.map((p) => p.guest)).toEqual([false, true]);
    const d = await S.live.teacherDetail(scopeOf(w), w.session.id);
    expect(d.publicPath).toBe(`/live/s/${w.session.id}`);
    expect(d.seats).toMatchObject({ taken: 2, studentBookings: 1, guestSeats: 1 });
  });
});

describe('Editing a session: state-aware and financially safe', () => {
  it('nobody committed: everything may change, FREE↔PAID included', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price() });
    const d = await S.live.teacherDetail(scopeOf(w), w.session.id);
    expect(d.edit).toMatchObject({ state: 'SCHEDULED', committed: false });
    expect(d.edit.editable).toContain('accessMode');
    await S.live.update(scopeOf(w), w.session.id, { accessMode: 'FREE', priceCents: null });
    expect(
      (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.session.id } })).accessMode,
    ).toBe('FREE');
  });

  it('a paying GUEST locks PAID→FREE (bookings alone used to miss this)', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    await S.commerce.guestHold(w.session.id, 'ضيف دافع');
    const err = await S.live
      .update(scopeOf(w), w.session.id, { accessMode: 'FREE', priceCents: null })
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ACCESS_MODE_LOCKED' });
    expect(
      (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.session.id } })).accessMode,
    ).toBe('PAID');
  });

  it('a new price applies to new buyers only: an existing purchase keeps its frozen snapshot', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: 10_000, students: 2 });
    const a = await S.commerce.hold(w.students[0].user.id, w.session.id);
    await S.live.update(scopeOf(w), w.session.id, { priceCents: 15_000 });
    expect(
      (await prisma.livePurchase.findUniqueOrThrow({ where: { id: a.id } })).basePriceCents,
    ).toBe(10_000);
    const b = await S.commerce.hold(w.students[1].user.id, w.session.id);
    expect(b.studentPaysCents).toBeGreaterThan(a.studentPaysCents);
  });

  it('capacity can never go below the seats already taken', async () => {
    if (!guard()) return;
    const w = await freeWorld({ capacity: 5, students: 2 });
    await S.live.book(w.students[0].user.id, w.session.id);
    await S.live.book(w.students[1].user.id, w.session.id);
    const err = await S.live.update(scopeOf(w), w.session.id, { capacity: 1 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CAPACITY_BELOW_TAKEN', taken: 2 });
    await S.live.update(scopeOf(w), w.session.id, { capacity: 2 });
  });

  it('with seats held: moving later is allowed (and announced); earlier is refused', async () => {
    if (!guard()) return;
    const w = await freeWorld({ students: 1 });
    await S.live.book(w.students[0].user.id, w.session.id);
    const later = new Date(w.session.startsAt.getTime() + 3600_000).toISOString();
    await S.live.update(scopeOf(w), w.session.id, { startsAt: later });
    expect(
      await prisma.auditLog.count({ where: { action: 'live.reschedule', entityId: w.session.id } }),
    ).toBe(1);
    const earlier = new Date(w.session.startsAt.getTime() - 3600_000).toISOString();
    const err = await S.live
      .update(scopeOf(w), w.session.id, { startsAt: earlier })
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'RESCHEDULE_EARLIER_LOCKED' });
  });

  it('LIVE: only the title and description; ENDED: read-only', async () => {
    if (!guard()) return;
    const w = await freeWorld({ startsInMs: -5 * 60_000, durationMin: 60 });
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { status: 'LIVE', startedAt: new Date() },
    });
    await S.live.update(scopeOf(w), w.session.id, { title: 'عنوان أوضح' });
    const err = await S.live.update(scopeOf(w), w.session.id, { capacity: 3 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'LIVE_EDIT_LOCKED' });
    await prisma.liveSession.update({
      where: { id: w.session.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    const ro = await S.live
      .update(scopeOf(w), w.session.id, { title: 'بعد النهاية' })
      .catch((e) => e);
    expect(ro.getResponse()).toMatchObject({ code: 'SESSION_READ_ONLY' });
    expect((await S.live.teacherDetail(scopeOf(w), w.session.id)).edit).toMatchObject({
      state: 'ENDED',
      editable: [],
    });
  });

  it('an unchanged field sent back by the form is not an edit', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    await S.commerce.guestHold(w.session.id, 'ضيف');
    await S.live.update(scopeOf(w), w.session.id, {
      title: w.session.title,
      accessMode: 'PAID',
      priceCents: w.session.priceCents,
      startsAt: w.session.startsAt.toISOString(),
    });
  });
});

describe('Paid seat: the listener completes it — no second action', () => {
  /** Money into Darsly's InstaPay account: the bank's SMS names the sender, no number. */
  const bankSms = (amountCents: number, payer: string) =>
    S.matching.ingest({
      provider: 'BANK_TRANSFER',
      amountCents,
      externalId: randomUUID(),
      rawMessage: `يرجى العلم انه تم تنفيذ تحويل لحظي بمبلغ ${(amountCents / 100).toFixed(2)} جم إلى حسابك المنتهي بـ **7717 من ${payer} على برقم مرجعي ${randomUUID().slice(0, 8)}`,
    });

  it('to an InstaPay account, a wallet sender must give their name (else nothing could match)', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'ضيف');
    await expect(
      S.commerce.guestDeclareTransfer(accessToken, {
        method: 'INSTAPAY',
        source: 'WALLET',
        senderWallet: '01112345678',
      }),
    ).rejects.toMatchObject({ response: { code: 'PAYER_NAME_REQUIRED' } });
  });

  it('the 27 Sep shape, fixed: wallet → Darsly InstaPay, declared with the name → the bank SMS confirms the seat by itself', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'ضيف');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'INSTAPAY',
      source: 'WALLET',
      senderWallet: '01112345678',
      payerName: 'أحمد عبد العزيز هريدي',
    });
    expect((await S.commerce.guestStatus(accessToken)).paymentStage).toBe('AWAITING_TRANSFER');
    const r = await bankSms(purchase.studentPaysCents, 'احمد عبدالعزيز هريدى');
    expect(r.status).toBe('MATCHED');
    // No proof, no "I paid": the seat is confirmed and the door is the guest's.
    const st = await S.commerce.guestStatus(accessToken);
    expect(st).toMatchObject({ status: 'CONFIRMED', paymentStage: 'CONFIRMED' });
    expect(await accountBalance(prisma, `purchase:${purchase.id}:held`)).toBe(
      purchase.studentPaysCents,
    );
    await expect(S.commerce.guestClassroomToken(accessToken)).resolves.toMatchObject({
      liveSessionId: w.session.id,
    });
  });

  it('a registered student: declare → SMS → CONFIRMED with a booking, nothing else pressed', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price() });
    const s = w.students[0];
    const p = await S.commerce.hold(s.user.id, w.session.id);
    const from = `0111${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    await S.commerce.declareTransfer(s.user.id, p.id, {
      method: 'VODAFONE_CASH',
      source: 'WALLET',
      senderWallet: from,
    });
    await S.matching.ingest({
      provider: 'VODAFONE_CASH',
      amountCents: p.studentPaysCents,
      externalId: randomUUID(),
      rawMessage: `تم استلام مبلغ ${(p.studentPaysCents / 100).toFixed(2)} جنيه من ${from} على رقم محفظتك ${OURS}. رقم العملية: 02${Date.now()}`,
    });
    const q = await S.commerce.quote(w.session.id, s.user.id);
    expect(q.purchase).toMatchObject({ status: 'CONFIRMED', paymentStage: 'CONFIRMED' });
    expect(await prisma.liveBooking.count({ where: { purchaseId: p.id } })).toBe(1);
  });

  it('an ambiguous transfer is shown to the buyer as "received, under review" — never "pay again"; nothing is confirmed', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, 'ضيف');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'INSTAPAY',
      source: 'BANK',
      payerName: 'سارة محمود حسن',
    });
    // The money arrives in someone else's name: the policy refuses to guess.
    const r = await bankSms(purchase.studentPaysCents, 'احمد عبدالعزيز هريدى');
    expect(r.status).toBe('AMBIGUOUS');
    const st = await S.commerce.guestStatus(accessToken);
    expect(st).toMatchObject({ status: 'HELD', paymentStage: 'UNDER_REVIEW' });
  });

  it('receipt-only still cannot verify: a proof with no SMS identity leaves the seat pending', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { priceCents: price(), students: 0 });
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'ضيف');
    await S.commerce.guestDeclareTransfer(accessToken, {
      method: 'INSTAPAY',
      source: 'BANK',
      payerName: 'سارة محمود حسن',
    });
    await S.commerce.guestSubmitTransfer(accessToken, { proofImageUrl: 'data:x' });
    expect((await S.commerce.guestStatus(accessToken)).status).toBe('PAYMENT_PENDING');
  });
});

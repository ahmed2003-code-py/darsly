import { randomUUID } from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@darsly/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { GUEST_ALLOWED_KEY } from '../../common/decorators/guest-allowed.decorator';
import { assertLiveReplayKey } from '../../playback/live-replay-access';
import { LiveCommerceService } from './live-commerce.service';
import { accountBalance, commerceStack, commerceWorld } from './testing';

/**
 * Commerce E against a real PostgreSQL: a paid seat without an account. The
 * access secret, the guest's token scope, verification through the same
 * listener path, and refunds sent by hand — each where only a database (or
 * the real guard) can prove it.
 */
const prisma = new PrismaService();
let available = true;
let S: ReturnType<typeof commerceStack>;
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-access-secret-for-guest-tokens-0123456789';

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.guestBuyer.count();
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
const sms = (amountCents: number, reference: string) =>
  S.matching.ingest({
    provider: 'VODAFONE_CASH',
    amountCents,
    reference,
    externalId: randomUUID(),
    identities: [reference],
  });

/** A guest who bought a seat and whose transfer the listener verified. */
async function confirmedGuest(opts: Parameters<typeof commerceWorld>[1] = {}) {
  const w = await commerceWorld(prisma, { students: 0, ...opts });
  const { accessToken } = await S.commerce.guestHold(w.session.id, 'زائر تجريبي');
  const ref = phone();
  await S.commerce.guestSubmitTransfer(accessToken, {
    method: 'VODAFONE_CASH',
    reference: ref,
    proofImageUrl: 'data:x',
  });
  expect((await sms(12_000, ref)).status).toBe('MATCHED');
  const status = await S.commerce.guestStatus(accessToken);
  return { w, token: accessToken, status };
}

/** Run the real global guards on a fake request, as the router would. */
async function runGuards(token: string, params: Record<string, string>, guestAllowed: boolean) {
  const reflector = {
    getAllAndOverride: (key: string) => (key === GUEST_ALLOWED_KEY ? guestAllowed : undefined),
  } as unknown as Reflector;
  const request: any = { headers: { authorization: `Bearer ${token}` }, params };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  await new JwtAuthGuard(new JwtService({}), reflector, prisma).canActivate(ctx);
  return new RolesGuard(reflector).canActivate(ctx);
}

describe('Commerce E on Postgres: a guest buys a seat', () => {
  it('a name is all it takes; the secret is 256 bits, returned once, stored only as its hash', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0 });
    const { accessToken, purchase } = await S.commerce.guestHold(w.session.id, '  أحمد  ');
    expect(accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.livePurchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { guestBuyer: { include: { user: true } } },
    });
    expect(row.accessTokenHash).toBe(LiveCommerceService.hashToken(accessToken));
    expect(JSON.stringify(row)).not.toContain(accessToken);
    // The guest can never sign in: no handle, no password.
    expect(row.guestBuyer?.user).toMatchObject({
      role: 'GUEST',
      email: null,
      phone: null,
      username: null,
      passwordHash: null,
      fullName: 'أحمد',
    });
    expect(row.studentId).toBeNull();
    expect(purchase.status).toBe('HELD');
  });

  it('an unknown, malformed or tampered secret all get the same answer', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0 });
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'Guest');
    const tampered = accessToken.slice(0, -1) + (accessToken.endsWith('A') ? 'B' : 'A');
    for (const bad of [tampered, 'x'.repeat(43), 'short', '../../etc', '']) {
      await expect(S.commerce.guestStatus(bad)).rejects.toMatchObject({
        response: { code: 'ACCESS_NOT_FOUND' },
      });
    }
  });

  it('the listener verifies a guest’s transfer through the same path; the seat counts against capacity', async () => {
    if (!guard()) return;
    const { w, status } = await confirmedGuest({ capacity: 1, students: 1 });
    expect(status.status).toBe('CONFIRMED');
    const pay = await prisma.payment.findFirstOrThrow({ where: { livePurchaseId: status.id } });
    expect(pay.studentId).toBeNull();
    expect(await accountBalance(prisma, `purchase:${status.id}:held`)).toBe(12_000);
    // A guest's seat has no LiveBooking, but it is still a taken seat.
    await expect(S.commerce.hold(w.students[0].user.id, w.session.id)).rejects.toMatchObject({
      response: { code: 'SESSION_FULL' },
    });
  });

  it('a classroom token for one session: that classroom’s chat, nothing else anywhere', async () => {
    if (!guard()) return;
    const { w, token } = await confirmedGuest();
    const other = await commerceWorld(prisma, { students: 0 });
    const t = await S.commerce.guestClassroomToken(token);
    expect(t.liveSessionId).toBe(w.session.id);
    const guestUserId = t.user.id;
    // Its seat lets it in, and it can talk in the room.
    await expect(S.live.assertInSession(guestUserId, w.session.id)).resolves.toMatchObject({
      role: 'STUDENT',
    });
    await expect(S.live.sendChat(guestUserId, w.session.id, 'السلام عليكم')).resolves.toBeDefined();
    // Not another class, even a paid one it could guess the id of.
    await expect(S.live.assertInSession(guestUserId, other.session.id)).rejects.toThrow();
    // The real guards: allowed route + its own session → through.
    await expect(runGuards(t.accessToken, { id: w.session.id }, true)).resolves.toBe(true);
    // Its token against another session's classroom route → refused.
    await expect(runGuards(t.accessToken, { id: other.session.id }, true)).rejects.toMatchObject({
      response: { code: 'GUEST_SCOPE' },
    });
    // Any route not opened to guests (profile, courses, wallet…) → refused.
    await expect(runGuards(t.accessToken, { id: w.session.id }, false)).rejects.toMatchObject({
      response: { code: 'GUEST_SCOPE' },
    });
    await expect(runGuards(t.accessToken, {}, false)).rejects.toMatchObject({
      response: { code: 'GUEST_SCOPE' },
    });
    // And it is never a course buyer.
    expect(await prisma.enrollment.count({ where: { student: { userId: guestUserId } } })).toBe(0);
  });

  it('no classroom token before the seat is confirmed', async () => {
    if (!guard()) return;
    const w = await commerceWorld(prisma, { students: 0 });
    const { accessToken } = await S.commerce.guestHold(w.session.id, 'Guest');
    await expect(S.commerce.guestClassroomToken(accessToken)).rejects.toMatchObject({
      response: { code: 'SEAT_NOT_ACTIVE' },
    });
  });

  it('a guest cancels in time: a refund request with their account, access revoked at once, token useless', async () => {
    if (!guard()) return;
    const { w, token } = await confirmedGuest({
      startsInMs: 3 * 86_400_000,
      refundPolicy: 'STANDARD',
    });
    const t = await S.commerce.guestClassroomToken(token);
    await expect(runGuards(t.accessToken, { id: w.session.id }, true)).resolves.toBe(true);
    // A refund is owed, so it must say where to send it.
    await expect(S.commerce.guestCancel(token, {})).rejects.toMatchObject({
      response: { code: 'REFUND_METHOD_INVALID' },
    });
    const after = await S.commerce.guestCancel(token, {
      method: 'VODAFONE_CASH',
      holderName: 'أحمد',
      handle: '01012345678',
    });
    expect(after.status).toBe('CANCELLED_BY_STUDENT');
    expect(after.refunds).toEqual([
      expect.objectContaining({
        status: 'REQUESTED',
        amountCents: 10_000,
        needsDestination: false,
      }),
    ]);
    // The old classroom token dies with the seat, and no new one is issued.
    await expect(runGuards(t.accessToken, { id: w.session.id }, true)).rejects.toThrow(
      'Session revoked',
    );
    await expect(S.commerce.guestClassroomToken(token)).rejects.toMatchObject({
      response: { code: 'SEAT_NOT_ACTIVE' },
    });
    await expect(S.live.assertInSession(t.user.id, w.session.id)).rejects.toThrow();
  });
});

describe('Commerce E on Postgres: refunds sent by hand', () => {
  it('teacher cancels → the guest names an account → finance approves and transfers → the ledger books it once', async () => {
    if (!guard()) return;
    const { w, token, status } = await confirmedGuest();
    const scope = { academyId: w.academyId, userId: w.teacher.id, manageAll: true, role: 'OWNER' };
    await S.live.remove(scope, w.session.id, w.teacher.id);
    let g = await S.commerce.guestStatus(token);
    expect(g.status).toBe('CANCELLED_BY_TEACHER');
    const r = g.refunds[0];
    expect(r).toMatchObject({
      reason: 'TEACHER_CANCEL',
      status: 'REQUESTED',
      amountCents: 12_000,
      needsDestination: true,
    });
    // Finance cannot approve a refund with nowhere to send it.
    await expect(S.commerce.approveRefund(r.id, 'admin')).rejects.toMatchObject({
      response: { code: 'REFUND_NO_DESTINATION' },
    });
    g = await S.commerce.guestRefundDestination(token, r.id, {
      method: 'INSTAPAY',
      holderName: 'Ahmed',
      handle: 'ahmed@instapay',
    });
    expect(g.refunds[0].needsDestination).toBe(false);
    await Promise.all([
      S.commerce.approveRefund(r.id, 'admin'),
      S.commerce.approveRefund(r.id, 'admin'),
    ]);
    // Held until the money actually leaves.
    expect(await accountBalance(prisma, `purchase:${status.id}:held`)).toBe(12_000);
    const cashBefore = await accountBalance(prisma, 'platform:cash');
    await Promise.allSettled([
      S.commerce.completeRefund(r.id, 'admin', 'IPN-778899'),
      S.commerce.completeRefund(r.id, 'admin', 'IPN-778899'),
    ]);
    expect(await accountBalance(prisma, `purchase:${status.id}:held`)).toBe(0);
    // platform:cash is an asset debited on the way in, credited on the way out.
    expect((await accountBalance(prisma, 'platform:cash')) - cashBefore).toBe(12_000);
    expect(
      await prisma.ledgerTransaction.count({ where: { idempotencyKey: `refund:${r.id}` } }),
    ).toBe(1);
    expect((await S.commerce.guestStatus(token)).refunds[0].status).toBe('COMPLETED');
  });

  it('a rejected refund is not lost: its parts become releasable again', async () => {
    if (!guard()) return;
    const { status } = await confirmedGuest({ startsInMs: 3 * 86_400_000 });
    await S.commerce.adminRefund(status.id, 'admin');
    const p = await prisma.livePurchase.findUniqueOrThrow({
      where: { id: status.id },
      include: { refunds: true },
    });
    expect(p.status).toBe('REFUND_PENDING');
    await S.commerce.rejectRefund(p.refunds[0].id, 'admin', 'duplicate claim');
    const parts = await prisma.$transaction((tx) => S.commerce.remainingParts(tx, p));
    expect(parts).toEqual({ fee: 2_000, teacher: 10_000, center: 0 });
  });
});

describe('Commerce E on Postgres: guest replay', () => {
  it('judged by the guest seat’s own frozen replay rights on every key', async () => {
    if (!guard()) return;
    for (const [policy, allowed] of [
      ['INCLUDED_FOREVER', true],
      ['NONE', false],
    ] as const) {
      const { w, token } = await confirmedGuest({ replayPolicy: policy });
      const t = await S.commerce.guestClassroomToken(token);
      await prisma.liveSession.update({
        where: { id: w.session.id },
        data: { status: 'ENDED', endedAt: new Date(), recordingVisibility: 'STUDENTS' },
      });
      const r = await prisma.liveReplaySession.create({
        data: {
          watermarkId: `DRS-L-${randomUUID().slice(0, 8)}`,
          liveSessionId: w.session.id,
          recordingId: 'rec',
          videoAssetId: `asset-${randomUUID()}`,
          userId: t.user.id,
          role: 'STUDENT',
          tenantId: w.tp.id,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const claims = { sid: r.id, wm: r.watermarkId, uid: t.user.id, aid: r.videoAssetId } as any;
      if (allowed)
        await expect(assertLiveReplayKey(prisma as any, claims)).resolves.toBeUndefined();
      else
        await expect(assertLiveReplayKey(prisma as any, claims)).rejects.toThrow(
          /replay not included/,
        );
    }
  });
});

describe('Listener hardening on Postgres', () => {
  it('one SMS can never verify two payments, however they race to reconcile', async () => {
    if (!guard()) return;
    // Two classes (no shared session lock), one sender, one amount, and a
    // transfer already on file before either payment: the exact shape where
    // two reconciles read the same UNMATCHED event at the same instant.
    for (let round = 0; round < 5; round++) {
      const price = 20_000 + Math.floor(Math.random() * 50_000);
      const [w1, w2] = await Promise.all([
        commerceWorld(prisma, { priceCents: price }),
        commerceWorld(prisma, { priceCents: price }),
      ]);
      const ref = phone();
      const a = await S.commerce.hold(w1.students[0].user.id, w1.session.id);
      const b = await S.commerce.hold(w2.students[0].user.id, w2.session.id);
      await S.commerce.submitTransfer(w1.students[0].user.id, a.id, {
        method: 'VODAFONE_CASH',
        reference: ref,
        proofImageUrl: 'data:x',
      });
      await S.commerce.submitTransfer(w2.students[0].user.id, b.id, {
        method: 'VODAFONE_CASH',
        reference: ref,
        proofImageUrl: 'data:x',
      });
      const ev = await prisma.paymentEvent.create({
        data: {
          provider: 'VODAFONE_CASH',
          amountCents: a.studentPaysCents,
          reference: ref,
          occurredAt: new Date(),
          status: 'UNMATCHED',
          dedupeKey: `test:${randomUUID()}`,
        },
      });
      const [pa, pb] = await Promise.all([
        prisma.payment.findFirstOrThrow({ where: { livePurchaseId: a.id } }),
        prisma.payment.findFirstOrThrow({ where: { livePurchaseId: b.id } }),
      ]);
      await Promise.all([S.matching.reconcilePayment(pa.id), S.matching.reconcilePayment(pb.id)]);
      const paid = await prisma.payment.count({
        where: { id: { in: [pa.id, pb.id] }, status: 'PAID' },
      });
      // One transfer can never verify two payments. With two buyers declaring
      // the same sending wallet it is not even given to one of them: the
      // policy refuses to guess, and the transfer waits for a person.
      expect(paid).toBe(0);
      const after = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: ev.id } });
      expect(after.matchedPaymentId).toBeNull();
    }
  });
});

void Role;

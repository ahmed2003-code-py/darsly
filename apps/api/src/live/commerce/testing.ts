import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../payments/ledger.service';
import { ManualPaymentsService } from '../../payments/manual-payments.service';
import { PaymentMatchingService } from '../../payments/payment-matching.service';
import { PaymentTargets } from '../../payments/payment-targets';
import { WalletService } from '../../wallet/wallet.service';
import { CommercialTermsService } from '../../commerce/commercial-terms.service';
import { LiveService } from '../live.service';
import { dailyProviders } from '../providers/testing';
import { LiveCommerceService } from './live-commerce.service';

/**
 * The real commerce stack wired by hand against a real database, for the
 * Postgres integration specs. Only the edges are stubbed: notifications, the
 * receipt reader and the object store — nothing that decides money.
 */
export function commerceStack(prisma: PrismaService) {
  const notifications = { create: async () => ({}) } as any;
  const proofs = {
    store: async () => `proof-${randomUUID()}`,
    discard: async () => undefined,
    urlFor: (k: string) => k,
  } as any;
  const proofReader = { read: async () => null } as any;
  const ledger = new LedgerService(prisma);
  const targets = new PaymentTargets();
  const manual = new ManualPaymentsService(prisma, ledger, notifications, proofs, proofReader, targets);
  const wallet = new WalletService(prisma, ledger, notifications, proofs, proofReader);
  const matching = new PaymentMatchingService(prisma, manual, wallet);
  const terms = new CommercialTermsService(prisma);
  const commerce = new LiveCommerceService(
    prisma,
    ledger,
    terms,
    targets,
    matching,
    notifications,
    proofs,
    proofReader,
  );
  commerce.onModuleInit();
  const academyStub = {
    assertAssignableTeacher: async (_academyId: string, userId: string) => {
      const tp = await prisma.teacherProfile.findUniqueOrThrow({ where: { userId } });
      return { userId, teacherProfileId: tp.id };
    },
  };
  const live = new LiveService(
    prisma,
    notifications,
    {} as any,
    dailyProviders({ closeRoom: async () => 'deleted' } as any),
    { emitToLive: () => undefined, emitToUser: () => undefined } as any,
    {} as any,
    academyStub as any,
    undefined,
    terms,
  );
  return { ledger, targets, manual, wallet, matching, terms, commerce, live };
}

/** A teacher with a personal academy (or a Center), a PAID session, and N students. */
export async function commerceWorld(
  prisma: PrismaService,
  opts: {
    students?: number;
    capacity?: number | null;
    priceCents?: number;
    center?: { teacherSharePercent: number } | null;
    startsInMs?: number;
    durationMin?: number;
    refundPolicy?: 'FLEXIBLE' | 'STANDARD' | 'STRICT' | 'NO_REFUND';
    replayPolicy?: 'NONE' | 'INCLUDED_FOREVER' | 'INCLUDED_DAYS';
    replayDays?: number | null;
  } = {},
) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Teacher ${k}`, email: `lc-t-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `lc-${k}`, status: 'APPROVED' } });
  await prisma.academy.create({ data: { id: tp.id, slug: `lc-${k}`, name: `A ${k}`, ownerUserId: teacher.id } });
  let academyId = tp.id;
  if (opts.center) {
    const c = await prisma.academy.create({
      data: {
        slug: `lcc-${k}`,
        name: `C ${k}`,
        kind: 'CENTER',
        ownerUserId: teacher.id,
        teacherSharePercent: opts.center.teacherSharePercent,
      },
    });
    await prisma.academyMembership.create({
      data: { userId: teacher.id, academyId: c.id, role: 'TEACHER', status: 'ACTIVE', joinedAt: new Date() },
    });
    academyId = c.id;
  }
  const session = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() + (opts.startsInMs ?? 2 * 86_400_000)),
      durationMin: opts.durationMin ?? 60,
      capacity: opts.capacity === undefined ? null : opts.capacity,
      accessMode: 'PAID',
      priceCents: opts.priceCents ?? 10_000,
      refundPolicy: opts.refundPolicy ?? 'STANDARD',
      replayPolicy: opts.replayPolicy ?? 'INCLUDED_FOREVER',
      replayDays: opts.replayDays ?? null,
      provider: 'CLOUDFLARE',
    },
  });
  const students = [];
  for (let i = 0; i < (opts.students ?? 1); i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `Student ${k} ${i}`, email: `lc-s-${k}-${i}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    students.push({ user: u, sp });
  }
  return { k, teacher, tp, academyId, session, students };
}

/** Put real money in a student's wallet, the way a verified top-up does. */
export async function fundWallet(prisma: PrismaService, ledger: LedgerService, studentId: string, cents: number) {
  await ledger.creditWallet(studentId, cents, 'test top-up');
}

/** Sum of every entry on an account (credits − debits). */
export async function accountBalance(prisma: PrismaService, account: string) {
  const rows = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { account }, _sum: { amountCents: true } });
  const c = rows.find((r) => r.direction === 'CREDIT')?._sum.amountCents ?? 0;
  const d = rows.find((r) => r.direction === 'DEBIT')?._sum.amountCents ?? 0;
  return c - d;
}

/** Every ledger transaction touching these accounts balances (debits = credits). */
export async function assertLedgerBalanced(prisma: PrismaService, txnIds: string[]) {
  for (const id of txnIds) {
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: id } });
    const d = entries.filter((e) => e.direction === 'DEBIT').reduce((a, e) => a + e.amountCents, 0);
    const c = entries.filter((e) => e.direction === 'CREDIT').reduce((a, e) => a + e.amountCents, 0);
    if (d !== c) throw new Error(`ledger transaction ${id} does not balance: ${d} != ${c}`);
  }
}

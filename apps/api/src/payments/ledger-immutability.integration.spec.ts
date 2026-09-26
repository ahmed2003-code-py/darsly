import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

/**
 * The ledger is append-only, enforced by the database (migration
 * 20261012140000): an edit, a delete, and the soft-delete middleware's
 * "delete" (which is an UPDATE of deletedAt) are all refused.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.ledgerEntry.count();
  } catch {
    available = false;
  }
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});

describe('Ledger immutability on Postgres', () => {
  it('refuses to edit, delete or soft-delete a ledger row', async () => {
    if (!available) return console.warn('skipping: no database reachable at DATABASE_URL');
    const ledger = new LedgerService(prisma);
    const student = await prisma.studentProfile.create({
      data: { user: { create: { role: 'STUDENT', fullName: 'Ledger test' } } },
    });
    const txnId = await ledger.creditWallet(student.id, 1_234, 'immutability test');
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId: txnId } });

    await expect(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountCents: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "LedgerEntry" WHERE id = ${entry.id}`).rejects.toThrow(/append-only/);
    // The middleware turns this into UPDATE ... SET deletedAt — refused too.
    await expect(prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerTransaction.update({ where: { id: txnId }, data: { description: 'x' } })).rejects.toThrow(/append-only/);
    await expect(prisma.ledgerTransaction.delete({ where: { id: txnId } })).rejects.toThrow(/append-only/);
    // Still there, still counting.
    expect(await ledger.walletBalance(student.id)).toBe(1_234);
  });
});

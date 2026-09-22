import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

/**
 * Architecture Reset Phase 7 — payouts draw on the ORGANISATION's balance
 * account: a Center's own account, or the teacher's for a PERSONAL workspace.
 * A teacher inside a Center never withdraws the Center's money, and a Center
 * never withdraws a teacher's personal balance.
 */

function makePrisma(academy: { id: string; kind: 'PERSONAL' | 'CENTER'; ownerUserId?: string } = { id: 'teacherT', kind: 'PERSONAL' }) {
  const methods = new Map<string, any>();
  const payouts = new Map<string, any>();
  const prisma: any = {
    academy: { findUnique: jest.fn().mockResolvedValue({ ownerUserId: 'owner1', ...academy }) },
    platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: 50000 }) },
    payoutMethodSaved: {
      findMany: jest.fn((args: any) => Promise.resolve([...methods.values()].filter((m) => m.academyId === args.where.academyId))),
      findFirst: jest.fn((args: any) => Promise.resolve([...methods.values()].find((m) => Object.entries(args.where).every(([k, v]) => m[k] === v)) ?? null)),
      count: jest.fn((args: any) => Promise.resolve([...methods.values()].filter((m) => m.academyId === args.where.academyId).length)),
      create: jest.fn(async ({ data }: any) => { const row = { id: `m${methods.size + 1}`, ...data }; methods.set(row.id, row); return row; }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn(async ({ where }: any) => methods.delete(where.id)),
    },
    payoutRequest: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
      create: jest.fn(async ({ data }: any) => { const row = { id: `po${payouts.size + 1}`, status: 'REQUESTED', ...data }; payouts.set(row.id, row); return row; }),
      findMany: jest.fn((args: any) => Promise.resolve([...payouts.values()].filter((p) => (args.where?.academyId ? p.academyId === args.where.academyId : true)))),
      findUnique: jest.fn(({ where, include }: any) => {
        const row = payouts.get(where.id);
        if (!row) return Promise.resolve(null);
        return Promise.resolve({ ...row, teacher: { userId: 'owner1' }, academy: { id: row.academyId, kind: academy.kind, ownerUserId: 'owner1' } });
      }),
      findUniqueOrThrow: jest.fn(({ where }: any) => Promise.resolve(payouts.get(where.id))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = payouts.get(where.id);
        if (!row) return { count: 0 };
        if (where.status?.notIn && where.status.notIn.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    _methods: methods,
    _payouts: payouts,
    $transaction: jest.fn(async (fn: any, _opts?: any) => fn(prisma)),
  };
  const ledger: any = { orgBalance: jest.fn().mockResolvedValue(0), recordPayout: jest.fn().mockResolvedValue(undefined) };
  const notifications: any = { create: jest.fn() };
  return { prisma, ledger, svc: new PayoutsService(prisma, ledger, notifications) };
}

describe('PayoutsService — organisation-scoped balance, not always the teacher', () => {
  it('a PERSONAL workspace payout method is stored with tenantId == academyId (legacy readers unaffected)', async () => {
    const { prisma, svc } = makePrisma({ id: 'teacherT', kind: 'PERSONAL' });
    const m = await svc.addMethod('teacherT', 'BANK_TRANSFER' as any, { iban: 'x' }, true);
    expect(m.academyId).toBe('teacherT');
    expect(m.tenantId).toBe('teacherT');
  });

  it('a Center payout method has no tenantId — it belongs to the organisation, not one author', async () => {
    const { svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    const m = await svc.addMethod('centerA', 'BANK_TRANSFER' as any, { iban: 'x' }, true);
    expect(m.academyId).toBe('centerA');
    expect(m.tenantId).toBeNull();
  });

  it('a Center payout draws on the Center\'s own balance, not the requester\'s personal one', async () => {
    const { prisma, ledger, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    ledger.orgBalance.mockResolvedValue(100_000);
    await svc.request('centerA', 60_000, methodId);
    expect(ledger.orgBalance).toHaveBeenCalledWith(expect.objectContaining({ id: 'centerA', kind: 'CENTER' }), expect.anything());
  });

  it('payout cannot exceed the organisation\'s available balance', async () => {
    const { prisma, ledger, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    ledger.orgBalance.mockResolvedValue(10_000);
    await expect(svc.request('centerA', 60_000, methodId)).rejects.toMatchObject({ response: { code: 'PAYOUT_EXCEEDS_BALANCE' } });
  });

  it('a payout method from a different organisation cannot be used (cross-scope 404, existence hidden)', async () => {
    const { svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await expect(svc.request('centerA', 60_000, 'method-from-center-b')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pending payouts count against the same balance — no double payout past what is available', async () => {
    const { prisma, ledger, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    ledger.orgBalance.mockResolvedValue(100_000);
    prisma.payoutRequest.aggregate.mockResolvedValue({ _sum: { amountCents: 80_000 } });
    await expect(svc.request('centerA', 60_000, methodId)).rejects.toMatchObject({ response: { code: 'PAYOUT_EXCEEDS_BALANCE' } });
  });

  it('minimum payout amount is still enforced for a Center', async () => {
    const { prisma, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    await expect(svc.request('centerA', 100, methodId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('processing a payout to COMPLETED re-checks the balance and books through recordPayout only', async () => {
    const { prisma, ledger, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    ledger.orgBalance.mockResolvedValue(100_000);
    const payout = await svc.request('centerA', 60_000, methodId);
    ledger.orgBalance.mockResolvedValue(100_000);
    await svc.process(payout.id, 'COMPLETED' as any, 'admin1');
    expect(ledger.recordPayout).toHaveBeenCalledWith(payout.id, expect.anything());
    expect(prisma._payouts.get(payout.id).status).toBe('COMPLETED');
  });

  it('a payout already finalized cannot be processed again (no double settlement)', async () => {
    const { prisma, ledger, svc } = makePrisma({ id: 'centerA', kind: 'CENTER' });
    await svc.addMethod('centerA', 'BANK_TRANSFER' as any, {}, true);
    const methodId = [...prisma._methods.keys()][0];
    ledger.orgBalance.mockResolvedValue(100_000);
    const payout = await svc.request('centerA', 60_000, methodId);
    prisma._payouts.get(payout.id).status = 'COMPLETED';
    await expect(svc.process(payout.id, 'COMPLETED' as any, 'admin1')).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.recordPayout).not.toHaveBeenCalled();
  });

  it('requesting against an unknown academy 404s', async () => {
    const { prisma, svc } = makePrisma();
    prisma.academy.findUnique.mockResolvedValue(null);
    await expect(svc.request('ghost', 60_000, 'm1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { GoneException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const RAW = 'raw-token-abc';

function makePrisma() {
  return {
    academyActivationToken: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ userId: 'u1', academyId: 'c1' }),
      updateMany: jest.fn(),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
    academyMembership: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    academy: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  } as any;
}
const svc = (prisma: any) => new AuthService(prisma, {} as any, {} as any, {} as any);
const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);

describe('AuthService.activationPreview', () => {
  it('looks the token up by its hash and reveals only name/email/center', async () => {
    const prisma = makePrisma();
    prisma.academyActivationToken.findUnique.mockResolvedValue({
      expiresAt: future, usedAt: null, revokedAt: null, user: { fullName: 'A', email: 'a@x' }, academy: { name: 'C' },
    });
    await expect(svc(prisma).activationPreview(RAW)).resolves.toEqual({ fullName: 'A', email: 'a@x', academyName: 'C' });
    expect(prisma.academyActivationToken.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: sha(RAW) });
  });

  it('unknown token → 404', async () => {
    const prisma = makePrisma();
    prisma.academyActivationToken.findUnique.mockResolvedValue(null);
    await expect(svc(prisma).activationPreview('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['expired', { expiresAt: past, usedAt: null, revokedAt: null }],
    ['used', { expiresAt: future, usedAt: past, revokedAt: null }],
    ['revoked', { expiresAt: future, usedAt: null, revokedAt: past }],
  ])('%s token → 410', async (_l, row) => {
    const prisma = makePrisma();
    prisma.academyActivationToken.findUnique.mockResolvedValue({ ...row, user: { fullName: 'A', email: null }, academy: { name: 'C' } });
    await expect(svc(prisma).activationPreview(RAW)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('AuthService.activateAccount', () => {
  it('claims the token atomically, then activates exactly the user/academy the token was issued for', async () => {
    const prisma = makePrisma();
    prisma.academyActivationToken.updateMany.mockResolvedValue({ count: 1 });
    await expect(svc(prisma).activateAccount({ token: RAW, password: 'Passw0rd!' })).resolves.toEqual({ ok: true });
    const claim = prisma.academyActivationToken.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ tokenHash: sha(RAW), usedAt: null, revokedAt: null });
    expect(claim.where.expiresAt.gt).toBeInstanceOf(Date);
    expect(prisma.user.update.mock.calls[0][0]).toMatchObject({ where: { id: 'u1' }, data: { isActive: true } });
    expect(prisma.user.update.mock.calls[0][0].data.passwordHash).toMatch(/^\$argon2/);
    expect(prisma.academyMembership.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u1', academyId: 'c1', status: 'INVITED' });
    expect(prisma.academy.updateMany.mock.calls[0][0].where).toEqual({ id: 'c1', status: 'PENDING' });
  });

  it('the identity it unlocks comes from the row, never from the request', async () => {
    const prisma = makePrisma();
    prisma.academyActivationToken.updateMany.mockResolvedValue({ count: 1 });
    await svc(prisma).activateAccount({ token: RAW, password: 'Passw0rd!', userId: 'attacker', academyId: 'other' } as any);
    expect(prisma.user.update.mock.calls[0][0].where).toEqual({ id: 'u1' });
    expect(prisma.academy.updateMany.mock.calls[0][0].where.id).toBe('c1');
  });

  it('a second redemption (replay / lost race) finds nothing to claim → 410, and touches nothing', async () => {
    const prisma = makePrisma();
    prisma.academyActivationToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc(prisma).activateAccount({ token: RAW, password: 'Passw0rd!' })).rejects.toBeInstanceOf(GoneException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('two concurrent redemptions: exactly one wins', async () => {
    const prisma = makePrisma();
    let claimed = false;
    prisma.academyActivationToken.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const s = svc(prisma);
    const results = await Promise.allSettled([
      s.activateAccount({ token: RAW, password: 'Passw0rd!' }),
      s.activateAccount({ token: RAW, password: 'Passw0rd!' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});

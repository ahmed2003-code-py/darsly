import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { InvitationLinksService } from './invitation-links.service';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function makePrisma() {
  return {
    academyInvitationLink: {
      create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
    },
    user: { findUniqueOrThrow: jest.fn() },
    academyMembership: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), create: jest.fn() },
  } as any;
}
const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);
const liveRow = (over: Record<string, unknown> = {}) => ({
  id: 'l1', tokenHash: sha('raw-token'), role: 'TEACHER', academyId: 'c1', expiresAt: future, usedAt: null, usedByUserId: null, revokedAt: null, declinedAt: null, declinedByUserId: null,
  academy: { name: 'Center', status: 'ACTIVE', deletedAt: null },
  ...over,
});
const eligibleUser = { role: 'TEACHER', isActive: true, teacherProfile: { status: 'APPROVED' } };

describe('InvitationLinksService.create', () => {
  it('stores only the hash, TTL defaults to 14 days, and returns the raw token exactly once', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.create.mockResolvedValue({ id: 'l1', role: 'TEACHER', expiresAt: future, createdAt: new Date() });
    const res = await new InvitationLinksService(prisma).create('c1', 'owner1', 'TEACHER' as any);
    const data = prisma.academyInvitationLink.create.mock.calls[0][0].data;
    expect(data.academyId).toBe('c1');
    expect(data.createdByUserId).toBe('owner1');
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.tokenHash).not.toBe(res.token); // hash, never the raw value
    const ttlDays = (data.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(13.9);
    expect(ttlDays).toBeLessThan(14.1);
    expect(res.token).toHaveLength(43); // 32 random bytes, base64url
  });
});

describe('InvitationLinksService.list', () => {
  it('derives status without ever returning a token', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findMany.mockResolvedValue([
      { id: 'a', role: 'TEACHER', expiresAt: future, usedAt: null, revokedAt: null, createdAt: new Date(), createdByUserId: 'o' },
      { id: 'b', role: 'TEACHER', expiresAt: future, usedAt: new Date(), revokedAt: null, createdAt: new Date(), createdByUserId: 'o' },
      { id: 'c', role: 'TEACHER', expiresAt: future, usedAt: null, revokedAt: new Date(), createdAt: new Date(), createdByUserId: 'o' },
      { id: 'd', role: 'TEACHER', expiresAt: past, usedAt: null, revokedAt: null, createdAt: new Date(), createdByUserId: 'o' },
    ]);
    const rows = await new InvitationLinksService(prisma).list('c1');
    expect(rows.map((r) => r.status)).toEqual(['PENDING', 'USED', 'REVOKED', 'EXPIRED']);
    expect(rows.every((r) => !('token' in r) && !('tokenHash' in r))).toBe(true);
  });
});

describe('InvitationLinksService.revoke', () => {
  it('revokes an unused link', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findFirst.mockResolvedValue({ id: 'l1', usedAt: null, revokedAt: null });
    await new InvitationLinksService(prisma).revoke('c1', 'l1');
    expect(prisma.academyInvitationLink.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { revokedAt: expect.any(Date) } });
  });
  it('refuses to revoke an already-used link', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findFirst.mockResolvedValue({ id: 'l1', usedAt: new Date(), revokedAt: null });
    await expect(new InvitationLinksService(prisma).revoke('c1', 'l1')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('a foreign-academy id 404s — never reveals another Center\'s link', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findFirst.mockResolvedValue(null);
    await expect(new InvitationLinksService(prisma).revoke('c1', 'l1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvitationLinksService.preview', () => {
  it('exposes only Center name, role, expiry', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow());
    await expect(new InvitationLinksService(prisma).preview('raw-token')).resolves.toEqual({ academyName: 'Center', role: 'TEACHER', expiresAt: future });
  });
  it.each([
    ['unknown', null],
    ['expired', liveRow({ expiresAt: past })],
    ['used', liveRow({ usedAt: past })],
    ['revoked', liveRow({ revokedAt: past })],
    ['declined', liveRow({ declinedAt: past, declinedByUserId: 'u9' })],
    ['suspended Center', liveRow({ academy: { name: 'C', status: 'SUSPENDED', deletedAt: null } })],
    ['archived Center', liveRow({ academy: { name: 'C', status: 'ARCHIVED', deletedAt: null } })],
    ['deleted Center', liveRow({ academy: { name: 'C', status: 'ACTIVE', deletedAt: new Date() } })],
  ])('%s → no sensitive detail leaked', async (_l, row) => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(row);
    await expect(new InvitationLinksService(prisma).preview('raw-token')).rejects.toThrow();
  });
});

describe('InvitationLinksService.accept', () => {
  const setup = (userOverrides: Record<string, unknown> = {}, rowOverrides: Record<string, unknown> = {}) => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow(rowOverrides));
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ...eligibleUser, ...userOverrides });
    prisma.academyInvitationLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.academyMembership.findUnique.mockResolvedValue(null);
    prisma.academyMembership.upsert.mockResolvedValue({ id: 'm1', academyId: 'c1', role: 'TEACHER', status: 'ACTIVE' });
    return prisma;
  };

  it('creates an ACTIVE membership from a fresh accept', async () => {
    const prisma = setup();
    const m = await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(m).toMatchObject({ status: 'ACTIVE', role: 'TEACHER' });
    expect(prisma.academyMembership.upsert.mock.calls[0][0].create).toMatchObject({ userId: 'u1', academyId: 'c1', role: 'TEACHER', status: 'ACTIVE' });
  });

  it('eligibility is checked BEFORE the token is claimed — an ineligible attempt does not burn it', async () => {
    const prisma = setup({ role: 'STUDENT' });
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toMatchObject({ response: { code: 'STUDENT_NOT_STAFF' } });
    expect(prisma.academyInvitationLink.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['STAFF identity', { role: 'STAFF', teacherProfile: null }],
    ['STUDENT identity', { role: 'STUDENT', teacherProfile: null }],
    ['PENDING teacher', { teacherProfile: { status: 'PENDING' } }],
    ['SUSPENDED teacher', { teacherProfile: { status: 'SUSPENDED' } }],
    ['REJECTED teacher', { teacherProfile: { status: 'REJECTED' } }],
    ['inactive account', { isActive: false }],
  ])('rejects %s', async (_l, over) => {
    const prisma = setup(over);
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });

  it('claims the token atomically; the claim query is bound to the exact row', async () => {
    const prisma = setup();
    await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(prisma.academyInvitationLink.updateMany.mock.calls[0][0].where).toMatchObject({ tokenHash: sha('raw-token'), usedAt: null, revokedAt: null });
  });

  it('a second redemption / lost race finds nothing to claim → 410, no membership written', async () => {
    const prisma = setup();
    prisma.academyInvitationLink.updateMany.mockResolvedValue({ count: 0 });
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toBeInstanceOf(GoneException);
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });

  it('two concurrent accepts: exactly one wins', async () => {
    const prisma = setup();
    let claimed = false;
    prisma.academyInvitationLink.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const svc = new InvitationLinksService(prisma);
    const results = await Promise.allSettled([svc.accept('raw-token', 'u1'), svc.accept('raw-token', 'u2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(prisma.academyMembership.upsert).toHaveBeenCalledTimes(1);
  });

  it('an existing ACTIVE membership is a conflict, not a silent success (token still consumed)', async () => {
    const prisma = setup();
    prisma.academyMembership.findUnique.mockResolvedValue({ id: 'm0', status: 'ACTIVE', role: 'TEACHER' });
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.academyInvitationLink.updateMany).toHaveBeenCalledTimes(1); // claimed before the conflict was found
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });

  it('a LEFT membership is reactivated straight to ACTIVE by this explicit accept', async () => {
    const prisma = setup();
    prisma.academyMembership.findUnique.mockResolvedValue({ id: 'm0', status: 'LEFT', role: 'TEACHER' });
    await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(prisma.academyMembership.upsert.mock.calls[0][0].update).toMatchObject({ status: 'ACTIVE', role: 'TEACHER' });
  });

  it('role and academyId always come from the stored row, never the accept call', async () => {
    const prisma = setup({}, { role: 'ASSISTANT', academyId: 'other-center' });
    await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(prisma.academyMembership.upsert.mock.calls[0][0].create).toMatchObject({ role: 'ASSISTANT', academyId: 'other-center' });
  });

  it('multi-Center: accepting into Center B only touches the (user, Center B) row — a teacher already ACTIVE in Center A, PERSONAL, or elsewhere is untouched', async () => {
    const prisma = setup({}, { academyId: 'centerB' });
    await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(prisma.academyMembership.findUnique).toHaveBeenCalledWith({ where: { userId_academyId: { userId: 'u1', academyId: 'centerB' } } });
    expect(prisma.academyMembership.upsert.mock.calls[0][0].where).toEqual({ userId_academyId: { userId: 'u1', academyId: 'centerB' } });
    // No query ever touches any other academyId for this user.
    expect(prisma.academyMembership.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('InvitationLinksService.accept — consumed links', () => {
  const consumedBy = (userId: string) => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow({ usedAt: past, usedByUserId: userId }));
    prisma.academyMembership.findFirst.mockResolvedValue({ id: 'm1', academyId: 'c1', role: 'TEACHER', status: 'ACTIVE' });
    return prisma;
  };

  it('the user who already won this link gets their membership back — a retried accept is not a failure', async () => {
    const prisma = consumedBy('u1');
    const m = await new InvitationLinksService(prisma).accept('raw-token', 'u1');
    expect(m).toMatchObject({ id: 'm1', academyId: 'c1', status: 'ACTIVE' });
    // Nothing is claimed or written again.
    expect(prisma.academyInvitationLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('a consumed link never transfers: any other user → 410, nothing written', async () => {
    const prisma = consumedBy('u1');
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u2')).rejects.toBeInstanceOf(GoneException);
    expect(prisma.academyInvitationLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
  });

  it('the winner removed from the Center since cannot walk back in on the old link → 410', async () => {
    const prisma = consumedBy('u1');
    prisma.academyMembership.findFirst.mockResolvedValue(null);
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toBeInstanceOf(GoneException);
  });

  it('a declined link cannot be accepted, even by the one who declined it', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow({ declinedAt: past, declinedByUserId: 'u1' }));
    await expect(new InvitationLinksService(prisma).accept('raw-token', 'u1')).rejects.toBeInstanceOf(GoneException);
    expect(prisma.academyInvitationLink.updateMany).not.toHaveBeenCalled();
  });
});

describe('InvitationLinksService.decline', () => {
  it('closes a live link for good and creates NO membership of any status', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow());
    prisma.academyInvitationLink.updateMany.mockResolvedValue({ count: 1 });
    const res = await new InvitationLinksService(prisma).decline('raw-token', 'u1');
    expect(res).toEqual({ id: 'l1', academyId: 'c1', role: 'TEACHER', declined: true });
    const call = prisma.academyInvitationLink.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ tokenHash: sha('raw-token'), usedAt: null, revokedAt: null, declinedAt: null });
    expect(call.data).toMatchObject({ declinedAt: expect.any(Date), declinedByUserId: 'u1' });
    expect(prisma.academyMembership.upsert).not.toHaveBeenCalled();
    expect(prisma.academyMembership.create).not.toHaveBeenCalled();
  });

  it('is idempotent for the person who declined', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(liveRow({ declinedAt: past, declinedByUserId: 'u1' }));
    prisma.academyInvitationLink.updateMany.mockResolvedValue({ count: 0 });
    await expect(new InvitationLinksService(prisma).decline('raw-token', 'u1')).resolves.toMatchObject({ declined: true });
  });

  it.each([
    ['used', liveRow({ usedAt: past, usedByUserId: 'u1' })],
    ['revoked', liveRow({ revokedAt: past })],
    ['expired', liveRow({ expiresAt: past })],
    ['declined by someone else', liveRow({ declinedAt: past, declinedByUserId: 'u9' })],
  ])('a %s link cannot be declined → 410', async (_l, row) => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(row);
    prisma.academyInvitationLink.updateMany.mockResolvedValue({ count: 0 });
    await expect(new InvitationLinksService(prisma).decline('raw-token', 'u1')).rejects.toBeInstanceOf(GoneException);
  });

  it('unknown token → 404', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findUnique.mockResolvedValue(null);
    await expect(new InvitationLinksService(prisma).decline('raw-token', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InvitationLinksService.list', () => {
  it('a declined link reads DECLINED — distinct from the owner revoking it', async () => {
    const prisma = makePrisma();
    prisma.academyInvitationLink.findMany.mockResolvedValue([
      { id: 'a', role: 'TEACHER', expiresAt: future, usedAt: null, revokedAt: null, declinedAt: past, createdAt: new Date(), createdByUserId: 'o' },
    ]);
    const rows = await new InvitationLinksService(prisma).list('c1');
    expect(rows[0].status).toBe('DECLINED');
  });
});

describe('InvitationLinksService.claimForNewUser (inside a registration transaction)', () => {
  const tx = () => ({
    academyInvitationLink: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    academyMembership: { create: jest.fn() },
  });

  it('claims the exact row, then builds the membership from the ROW — academyId and role are never the caller\'s to say', async () => {
    const t = tx();
    t.academyInvitationLink.updateMany.mockResolvedValue({ count: 1 });
    t.academyInvitationLink.findUniqueOrThrow.mockResolvedValue({ academyId: 'center-from-row', role: 'ASSISTANT' });
    t.academyMembership.create.mockImplementation(async ({ data }: any) => ({ id: 'm1', ...data }));
    const m = await new InvitationLinksService(makePrisma()).claimForNewUser(t as any, sha('raw-token'), 'new-user');
    expect(t.academyInvitationLink.updateMany.mock.calls[0][0].where).toMatchObject({ tokenHash: sha('raw-token'), usedAt: null, revokedAt: null, declinedAt: null });
    expect(t.academyInvitationLink.updateMany.mock.calls[0][0].data).toMatchObject({ usedByUserId: 'new-user' });
    expect(t.academyMembership.create.mock.calls[0][0].data).toEqual({ userId: 'new-user', academyId: 'center-from-row', role: 'ASSISTANT', status: 'ACTIVE', joinedAt: expect.any(Date) });
    expect(m).toMatchObject({ academyId: 'center-from-row', role: 'ASSISTANT', status: 'ACTIVE' });
  });

  it('a link that cannot be claimed throws inside the transaction — so the account creation around it rolls back', async () => {
    const t = tx();
    t.academyInvitationLink.updateMany.mockResolvedValue({ count: 0 });
    await expect(new InvitationLinksService(makePrisma()).claimForNewUser(t as any, sha('raw-token'), 'new-user')).rejects.toBeInstanceOf(GoneException);
    expect(t.academyMembership.create).not.toHaveBeenCalled();
  });
});

describe('Invitation link creation stays behind member.manage (OWNER only)', () => {
  it('a TEACHER membership cannot reach the create/revoke routes — only OWNER (and platform admin) hold member.manage', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ROLE_PERMISSIONS } = require('./permissions');
    expect(ROLE_PERMISSIONS.OWNER).toContain('member.manage');
    expect(ROLE_PERMISSIONS.TEACHER).not.toContain('member.manage');
    expect(ROLE_PERMISSIONS.ASSISTANT).not.toContain('member.manage');
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain('member.manage');
  });
});

import { BadRequestException, ConflictException, GoneException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Signup through a Center invitation link. The contract under test:
 * everything that decides WHO the account becomes and WHERE it belongs comes
 * from the invitation row — never the request — and the account is the
 * Center's, not the platform's.
 */
function harness(role: 'TEACHER' | 'ASSISTANT' = 'TEACHER') {
  const tx = {
    user: { create: jest.fn() },
    academy: { upsert: jest.fn() },
    academyMembership: { upsert: jest.fn() },
  };
  tx.user.create.mockImplementation(async ({ data }: any) => ({
    id: 'new-user', role: data.role, email: data.email, fullName: data.fullName, passwordHash: data.passwordHash, failedLogins: 0, lockedUntil: null,
    teacherProfile: { id: 'tp-new', status: data.teacherProfile.create.status, slug: data.teacherProfile.create.slug, stages: data.teacherProfile.create.stages },
    studentProfile: null,
  }));
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    subject: { count: jest.fn().mockResolvedValue(1) },
    teacherProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    academy: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const tokenService = { createSession: jest.fn().mockResolvedValue({ accessToken: 'a', refreshToken: 'r', kickedSessions: 0 }) };
  const mail = { sendInBackground: jest.fn(), send: jest.fn(), webUrl: (p: string) => p };
  const links = {
    resolveLive: jest.fn().mockResolvedValue({ tokenHash: 'hash', role, academyId: 'center-1', expiresAt: new Date(Date.now() + 60_000), academy: { name: 'Center' } }),
    claimForNewUser: jest.fn().mockImplementation(async (_tx: any, _hash: string, userId: string) => ({ id: 'm1', academyId: 'center-1', role, status: 'ACTIVE', userId })),
  };
  const svc = new AuthService(prisma, tokenService as any, mail as any, links as any);
  return { svc, prisma, tx, tokenService, mail, links };
}

const body = (over: Record<string, unknown> = {}) => ({
  token: 'raw-token', email: 'New@Example.com', fullName: 'New Teacher', password: 'Passw0rd!', phone: '01012345678',
  subjectIds: ['s1'], stages: ['SECONDARY' as const], ...over,
});

describe('AuthService.registerViaInvitation — TEACHER invitation', () => {
  it('creates an APPROVED teacher identity, joins the Center from the row, logs in — no approval queue, no PERSONAL academy, no platform email', async () => {
    const { svc, tx, tokenService, mail, links } = harness('TEACHER');
    const res = await svc.registerViaInvitation(body(), { ip: '1.1.1.1' });

    const created = tx.user.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ role: 'TEACHER', email: 'new@example.com', fullName: 'New Teacher' });
    expect(created.teacherProfile.create.status).toBe('APPROVED');
    expect(created.teacherProfile.create.subjects.create).toEqual([{ subjectId: 's1' }]);
    expect(created.teacherProfile.create.stages).toEqual(['SECONDARY']);
    expect(created.studentProfile).toBeUndefined();

    // The claim happens inside the same transaction, keyed by the row's hash and the id just created.
    expect(links.claimForNewUser).toHaveBeenCalledWith(tx, 'hash', 'new-user');
    // Not a platform teacher: no PERSONAL academy provisioned, no OWNER membership, nobody at the platform notified.
    expect(tx.academy.upsert).not.toHaveBeenCalled();
    expect(tx.academyMembership.upsert).not.toHaveBeenCalled();
    expect(mail.sendInBackground).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();

    // Signed in at once, with the teacher identity as authorship tenant.
    expect(tokenService.createSession).toHaveBeenCalledWith({ id: 'new-user', role: 'TEACHER', tenantId: 'tp-new' }, expect.objectContaining({ ip: '1.1.1.1' }));
    expect(res).toMatchObject({ isNewUser: true, accessToken: 'a', refreshToken: 'r', membership: { academyId: 'center-1', role: 'TEACHER', status: 'ACTIVE' } });
    expect(res.user).not.toHaveProperty('passwordHash');
  });

  it('subjects and stages are mandatory for a TEACHER — nothing is created without them', async () => {
    const { svc, tx } = harness('TEACHER');
    await expect(svc.registerViaInvitation(body({ subjectIds: [] }), {})).rejects.toMatchObject({ response: { code: 'SUBJECT_REQUIRED' } });
    await expect(svc.registerViaInvitation(body({ stages: [] }), {})).rejects.toMatchObject({ response: { code: 'STAGES_REQUIRED' } });
    await expect(svc.registerViaInvitation(body({ subjectIds: undefined, stages: undefined }), {})).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.registerViaInvitation — ASSISTANT invitation', () => {
  it('needs no subjects/stages, still gets the teacher identity the Center checks staff against, joins as ASSISTANT', async () => {
    const { svc, tx } = harness('ASSISTANT');
    const res = await svc.registerViaInvitation(body({ subjectIds: undefined, stages: undefined }), {});
    const created = tx.user.create.mock.calls[0][0].data;
    expect(created.role).toBe('TEACHER');
    expect(created.teacherProfile.create.status).toBe('APPROVED');
    expect(created.teacherProfile.create.subjects.create).toEqual([]);
    expect(created.teacherProfile.create.stages).toEqual([]);
    expect(res.membership).toMatchObject({ role: 'ASSISTANT', academyId: 'center-1' });
    expect(tx.academy.upsert).not.toHaveBeenCalled();
  });
});

describe('AuthService.registerViaInvitation — the request decides nothing about role, Center or owner', () => {
  it('extra fields naming a role, an academy or an owner are ignored: membership comes from the row', async () => {
    const { svc, links, tx } = harness('ASSISTANT');
    const res = await svc.registerViaInvitation(
      body({ subjectIds: undefined, stages: undefined, role: 'TEACHER', academyId: 'attacker-center', ownerUserId: 'attacker', membershipRole: 'OWNER' }) as any,
      {},
    );
    expect(res.membership).toMatchObject({ role: 'ASSISTANT', academyId: 'center-1' });
    expect(links.claimForNewUser).toHaveBeenCalledWith(tx, 'hash', 'new-user');
    expect(tx.user.create.mock.calls[0][0].data.role).toBe('TEACHER');
  });

  it('a TEACHER link cannot be turned into an ASSISTANT membership (or vice versa) by the client', async () => {
    const { svc } = harness('TEACHER');
    const res = await svc.registerViaInvitation(body({ role: 'ASSISTANT' }) as any, {});
    expect(res.membership.role).toBe('TEACHER');
  });
});

describe('AuthService.registerViaInvitation — dead links and failures leave nothing behind', () => {
  it('an expired/revoked/used/declined link (resolveLive throws) creates no account', async () => {
    const { svc, links, tx, tokenService } = harness();
    links.resolveLive.mockRejectedValue(new GoneException({ code: 'INVITATION_LINK_INVALID' }));
    await expect(svc.registerViaInvitation(body(), {})).rejects.toBeInstanceOf(GoneException);
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tokenService.createSession).not.toHaveBeenCalled();
  });

  it('a claim lost inside the transaction fails the whole registration — no session is issued for a rolled-back user', async () => {
    const { svc, links, tokenService, prisma } = harness();
    links.claimForNewUser.mockRejectedValue(new GoneException({ code: 'INVITATION_LINK_INVALID' }));
    await expect(svc.registerViaInvitation(body(), {})).rejects.toBeInstanceOf(GoneException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // user.create ran inside it and was rolled back with it
    expect(tokenService.createSession).not.toHaveBeenCalled();
  });

  it('an email already registered is a 409 — the existing account should sign in and accept instead', async () => {
    const { svc, prisma, tx } = harness();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'someone' });
    await expect(svc.registerViaInvitation(body(), {})).rejects.toBeInstanceOf(ConflictException);
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});

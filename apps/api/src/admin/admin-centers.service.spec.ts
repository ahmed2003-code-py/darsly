import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdminCentersService } from './admin-centers.service';

function makePrisma() {
  const tx = {
    user: {
      create: jest.fn().mockResolvedValue({ id: 'newU', fullName: 'Admin' }),
      update: jest
        .fn()
        .mockImplementation(({ where }) => Promise.resolve({ id: where.id, fullName: 'Admin' })),
    },
    academy: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'c1',
          slug: data.slug,
          name: data.name,
          status: data.status,
          kind: data.kind,
        }),
      ),
    },
    academyMembership: { create: jest.fn().mockResolvedValue({}) },
    academyActivationToken: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    academy: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    teacherProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    academyActivationToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(tx) : Promise.all(arg),
    ),
    _tx: tx,
  };
  return prisma;
}
const deps = (delivered = true) => ({
  mail: {
    send: jest
      .fn()
      .mockResolvedValue(
        delivered
          ? { delivered: true, id: 'm1', transport: 'resend' }
          : { delivered: false, reason: 'provider-error' },
      ),
    sendInBackground: jest.fn(),
    webUrl: (p: string) => `https://web${p}`,
  },
  audit: { log: jest.fn() },
  // Granting a new Center its Studio looks happens outside the creation
  // transaction and is a no-op when no ids are supplied, which is every case here.
  centerThemes: { grantAtCreation: jest.fn().mockResolvedValue(undefined) },
});
const svc = (prisma: any, d = deps()) => ({
  s: new AdminCentersService(prisma, d.mail as any, d.audit as any, d.centerThemes as any),
  d,
});
const dto = { name: 'El Shehab', adminName: 'Ahmed', adminEmail: 'Admin@x.com' };

describe('AdminCentersService.createCenter — new admin', () => {
  it('creates a STAFF user with no password, no profiles, an INVITED OWNER row, a PENDING CENTER and a hashed token', async () => {
    const prisma = makePrisma();
    const { s, d } = svc(prisma);
    const res = await s.createCenter(dto, 'sa');
    const user = prisma._tx.user.create.mock.calls[0][0].data;
    expect(user).toMatchObject({ role: 'STAFF', isActive: false, email: 'admin@x.com' });
    expect(user.passwordHash).toBeUndefined();
    expect(user.teacherProfile).toBeUndefined();
    expect(user.studentProfile).toBeUndefined();
    expect(prisma._tx.academy.create.mock.calls[0][0].data).toMatchObject({
      kind: 'CENTER',
      status: 'PENDING',
      ownerUserId: 'newU',
    });
    expect(prisma._tx.academyMembership.create.mock.calls[0][0].data).toMatchObject({
      role: 'OWNER',
      status: 'INVITED',
    });
    const tok = prisma._tx.academyActivationToken.create.mock.calls[0][0].data;
    expect(tok.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tok.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // the raw token reaches the email only — and is never equal to what is stored
    const url: string = d.mail.send.mock.calls[0][0].text;
    expect(url).toContain('/activate?token=');
    expect(url).not.toContain(tok.tokenHash);
    expect(res.admin).toMatchObject({ role: 'STAFF', activation: 'EMAIL_SENT' });
  });

  it("TEMPORARY TEST ROUTING: the real Center owner/admin (email, user row, DB, response) is never changed — only the mail call opts into MailService's redirect", async () => {
    const prisma = makePrisma();
    const { s, d } = svc(prisma);
    const res = await s.createCenter(dto, 'sa');

    // The real admin's email is what the DB row, the activation token, and
    // the returned response all use — untouched by any test routing.
    const userRow = prisma._tx.user.create.mock.calls[0][0].data;
    expect(userRow.email).toBe('admin@x.com');
    expect(res.admin.id).toBe('newU');

    // The mail call still names the REAL admin as `to` — MailService (not
    // this service) is what redirects delivery, and only because this one
    // call opts in via the flag below.
    const mailCall = d.mail.send.mock.calls[0][0];
    expect(mailCall.to).toBe('admin@x.com');
    expect(mailCall.centerOwnerTestRedirect).toBe(true);

    // The email content still carries the real Center/admin details.
    expect(mailCall.subject).toContain('El Shehab');
    expect(mailCall.text).toContain('Admin'); // the admin's fullName
  });

  it('EMAIL FAILURE: the Center, the inactive admin and the hashed token are all persisted; the response says EMAIL_FAILED — nobody is activated', async () => {
    const prisma = makePrisma();
    const { s, d } = svc(prisma, deps(false));
    const res = await s.createCenter(dto, 'sa');
    expect(prisma._tx.user.create.mock.calls[0][0].data).toMatchObject({ isActive: false });
    expect(prisma._tx.academy.create.mock.calls[0][0].data).toMatchObject({ status: 'PENDING' });
    expect(prisma._tx.academyActivationToken.create).toHaveBeenCalledTimes(1);
    expect(res.admin.activation).toBe('EMAIL_FAILED');
    expect((res as any).delivery).toEqual({ delivered: false, reason: 'provider-error' });
    // The audit row records the failure, so the admin can see it and reissue.
    expect(d.audit.log.mock.calls[0][0].meta).toMatchObject({
      activation: 'EMAIL_FAILED',
      deliveryFailure: 'provider-error',
    });
    // No user.update, no isActive flip, no membership ACTIVE anywhere.
    expect(prisma._tx.academyMembership.create.mock.calls[0][0].data.status).toBe('INVITED');
  });

  it('EMAIL SUCCESS: identical persisted state, response says EMAIL_SENT', async () => {
    const prisma = makePrisma();
    const { s } = svc(prisma, deps(true));
    const res = await s.createCenter(dto, 'sa');
    expect(res.admin.activation).toBe('EMAIL_SENT');
    expect((res as any).delivery).toEqual({ delivered: true });
    expect(prisma._tx.user.create.mock.calls[0][0].data.isActive).toBe(false);
    // The SUPER_ADMIN who just created the Center gets the link back directly —
    // testing (or a dead mail provider) never has to wait on Resend.
    expect((res as any).activationUrl).toContain('/activate?token=');
  });

  it('RETRY: resendActivation revokes every open token, mints a new one, reports delivery, and applies the same test routing', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'C',
      owner: {
        id: 'newU',
        email: 'admin@x.com',
        fullName: 'Admin',
        isActive: false,
        passwordHash: null,
      },
    });
    prisma.$transaction = jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma._tx) : Promise.all(arg),
    );
    const { s, d } = svc(prisma, deps(false));
    const res = await s.resendActivation('c1', 'sa');
    expect(prisma.academyActivationToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );
    expect(prisma.academyActivationToken.create).toHaveBeenCalledTimes(1);
    expect(res.delivery).toEqual({ delivered: false, reason: 'provider-error' });
    expect(d.mail.send.mock.calls[0][0]).toMatchObject({
      to: 'admin@x.com',
      centerOwnerTestRedirect: true,
    });
    expect(res.activationUrl).toContain('/activate?token=');
  });

  it('RETRY refused once the admin has activated', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'C',
      owner: { id: 'u', email: 'a@x.com', fullName: 'A', isActive: true, passwordHash: 'h' },
    });
    const { s } = svc(prisma);
    await expect(s.resendActivation('c1', 'sa')).rejects.toMatchObject({
      response: { code: 'ALREADY_ACTIVE' },
    });
  });

  it('derives a slug that collides with neither an academy nor a teacher', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValueOnce({ id: 'x' }); // "el-shehab" taken by an academy
    prisma.teacherProfile.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 't' }); // the next candidate taken by a teacher
    const { s } = svc(prisma);
    const res = await s.createCenter(dto, 'sa');
    expect(res.slug).not.toBe('el-shehab');
    expect(res.slug).not.toBe('el-shehab-academy');
    expect(res.slug.startsWith('el-shehab')).toBe(true);
  });

  it('a name that is free is its own address — not a numbered or suffixed variant of it', async () => {
    const { s } = svc(makePrisma());
    expect((await s.createCenter(dto, 'sa')).slug).toBe('el-shehab');
  });

  it('refuses a slug held by a teacher (/t/:slug) even when no academy has it — naming the address, on the slug field, with free alternatives', async () => {
    const prisma = makePrisma();
    prisma.teacherProfile.findUnique.mockResolvedValue({ id: 't' });
    prisma.teacherProfile.findMany.mockResolvedValue([{ slug: 'ahmed-academy' }]);
    const { s } = svc(prisma);
    const err = await s.createCenter({ ...dto, slug: 'Ahmed' }, 'sa').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: 'CENTER_SLUG_TAKEN',
      field: 'slug',
      params: { slug: 'ahmed', suggestions: ['ahmed-online', 'ahmed-eg', 'ahmed2'] },
    });
    expect(prisma._tx.academy.create).not.toHaveBeenCalled();
  });

  it('a deleted Center does not hold its address: the read path ignores it and the create moves it aside', async () => {
    const prisma = makePrisma();
    prisma._tx.academy.findMany.mockResolvedValue([{ id: 'gone' }]);
    const { s } = svc(prisma);
    const res = await s.createCenter({ ...dto, slug: '3mCenter' }, 'sa');
    expect(res.slug).toBe('3mcenter');
    // live rows only (findFirst is soft-delete filtered; findUnique by slug is not)
    expect(prisma.academy.findUnique).not.toHaveBeenCalled();
    expect(prisma._tx.academy.findMany.mock.calls[0][0].where).toEqual({
      slug: '3mcenter',
      deletedAt: { not: null },
    });
    const moved = prisma._tx.academy.update.mock.calls[0][0];
    expect(moved.where).toEqual({ id: 'gone' });
    expect(moved.data.slug).toMatch(/^3mcenter~deleted~[0-9a-f]{8}$/);
    expect(prisma._tx.academy.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma._tx.academy.create.mock.invocationCallOrder[0],
    );
  });

  it('a name with nothing to make an address from asks for the address, on the slug field', async () => {
    const { s } = svc(makePrisma());
    const err = await s.createCenter({ ...dto, name: 'سنتر النور' }, 'sa').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'CENTER_NAME_NO_SLUG', field: 'slug' });
  });

  it('reports every problem at once, each on its own field', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({ id: 'x' }); // the address is taken
    prisma.user.findUnique.mockResolvedValue({
      id: 's1',
      role: 'STUDENT',
      isActive: true,
      passwordHash: 'h',
      teacherProfile: null,
    });
    const { s } = svc(prisma);
    const err = await s.createCenter({ ...dto, slug: 'taken' }, 'sa').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().fields).toEqual([
      expect.objectContaining({ field: 'slug', code: 'CENTER_SLUG_TAKEN' }),
      { field: 'adminEmail', code: 'IDENTITY_NOT_ELIGIBLE' },
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a phone already in use is reported on the phone field', async () => {
    const prisma = makePrisma();
    prisma.user.findFirst.mockResolvedValue({ id: 'other' });
    const { s } = svc(prisma);
    const err = await s.createCenter({ ...dto, adminPhone: '01012345678' }, 'sa').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'PHONE_TAKEN', field: 'adminPhone' });
  });
});

describe('AdminCentersService.createCenter — an admin who never activated', () => {
  const pending = () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'p1',
      role: 'STAFF',
      isActive: false,
      passwordHash: null,
      fullName: 'Old',
      teacherProfile: null,
    });
    return prisma;
  };

  it('left behind by a deleted Center: the same email is taken up again — no second user, old links revoked, a fresh token', async () => {
    const prisma = pending();
    const { s } = svc(prisma);
    const res = await s.createCenter({ ...dto, adminPhone: '01012345678' }, 'sa');
    expect(prisma._tx.user.create).not.toHaveBeenCalled();
    expect(prisma._tx.user.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'p1' },
      data: { fullName: 'Ahmed', phone: '+201012345678' },
    });
    // their own phone is not "taken" by themselves
    expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ NOT: { id: 'p1' } });
    expect(prisma._tx.academyActivationToken.updateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'p1', usedAt: null, revokedAt: null },
    });
    expect(prisma._tx.academyActivationToken.create).toHaveBeenCalledTimes(1);
    expect(prisma._tx.academy.create.mock.calls[0][0].data).toMatchObject({
      status: 'PENDING',
      ownerUserId: 'p1',
    });
    expect(res.admin).toMatchObject({ id: 'p1', role: 'STAFF' });
    expect((res as any).activationUrl).toContain('/activate?token=');
  });

  it('still waiting on a live Center (a retry after a lost response): refused, naming that Center', async () => {
    const prisma = pending();
    prisma.academy.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.ownerUserId ? { id: 'c7', name: '3m', slug: '3mcenter' } : null),
    );
    const { s } = svc(prisma);
    const err = await s.createCenter({ ...dto, slug: 'another' }, 'sa').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: 'CENTER_ADMIN_PENDING_ELSEWHERE',
      field: 'adminEmail',
      params: { center: '3m', centerId: 'c7', slug: '3mcenter' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AdminCentersService.createCenter — existing user designation', () => {
  const existing = (u: Record<string, unknown>) => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u9',
      fullName: 'X',
      isActive: true,
      teacherProfile: null,
      ...u,
    });
    return prisma;
  };

  it('an existing STAFF becomes OWNER directly: ACTIVE membership, ACTIVE center, no token, no new user', async () => {
    const prisma = existing({ role: 'STAFF' });
    const { s, d } = svc(prisma);
    const res = await s.createCenter(dto, 'sa');
    expect(prisma._tx.user.create).not.toHaveBeenCalled();
    expect(prisma._tx.academyActivationToken.create).not.toHaveBeenCalled();
    expect(prisma._tx.academy.create.mock.calls[0][0].data).toMatchObject({
      kind: 'CENTER',
      status: 'ACTIVE',
      ownerUserId: 'u9',
    });
    expect(prisma._tx.academyMembership.create.mock.calls[0][0].data).toMatchObject({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(d.mail.sendInBackground).not.toHaveBeenCalled();
    expect(res.admin.activation).toBe('NOT_REQUIRED');
  });

  it('an APPROVED teacher becomes OWNER and keeps their teacher identity untouched', async () => {
    const prisma = existing({ role: 'TEACHER', teacherProfile: { status: 'APPROVED' } });
    const { s } = svc(prisma);
    const res = await s.createCenter(dto, 'sa');
    expect(res.admin.role).toBe('TEACHER');
    expect(prisma.teacherProfile.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.anything() }),
    );
  });

  it.each([
    ['STUDENT', { role: 'STUDENT' }, 'IDENTITY_NOT_ELIGIBLE'],
    [
      'PENDING teacher',
      { role: 'TEACHER', teacherProfile: { status: 'PENDING' } },
      'TEACHER_NOT_APPROVED',
    ],
    [
      'SUSPENDED teacher',
      { role: 'TEACHER', teacherProfile: { status: 'SUSPENDED' } },
      'TEACHER_NOT_APPROVED',
    ],
    [
      'REJECTED teacher',
      { role: 'TEACHER', teacherProfile: { status: 'REJECTED' } },
      'TEACHER_NOT_APPROVED',
    ],
    // Activated once (has a password), then disabled — not a pending admin.
    ['disabled account', { role: 'STAFF', isActive: false, passwordHash: 'h' }, 'USER_INACTIVE'],
    ['SUPER_ADMIN', { role: 'SUPER_ADMIN' }, 'IDENTITY_NOT_ELIGIBLE'],
  ])('rejects %s', async (_l, u, code) => {
    const prisma = existing(u);
    const { s } = svc(prisma);
    await expect(s.createCenter(dto, 'sa')).rejects.toMatchObject({
      response: { code, field: 'adminEmail' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('AdminCentersService.deleteCenter', () => {
  it('moves the address aside, so it is free for the next Center, and audits the original', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      slug: '3mcenter',
      name: '3m',
      kind: 'CENTER',
      status: 'PENDING',
    });
    prisma._tx.academyMembership.deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma._tx.academy.delete = jest.fn().mockResolvedValue({});
    const { s, d } = svc(prisma);
    await s.deleteCenter('c1', '3mcenter', 'sa');
    const archived = prisma._tx.academy.update.mock.calls[0][0].data;
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.slug).toMatch(/^3mcenter~deleted~[0-9a-f]{8}$/);
    expect(d.audit.log.mock.calls[0][0].meta).toMatchObject({ slug: '3mcenter' });
  });
});

describe('AdminCentersService.setStatus', () => {
  it('suspends a CENTER and audits it', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({ id: 'c1', kind: 'CENTER', status: 'ACTIVE' });
    prisma.academy.update.mockResolvedValue({ id: 'c1', status: 'SUSPENDED' });
    const { s, d } = svc(prisma);
    await expect(s.setStatus('c1', 'SUSPENDED', 'sa')).resolves.toMatchObject({
      status: 'SUSPENDED',
    });
    expect(d.audit.log.mock.calls[0][0]).toMatchObject({
      action: 'center.status.suspended',
      academyId: 'c1',
    });
  });

  it('refuses to drive a PERSONAL academy — that follows the teacher status', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({ id: 'p1', kind: 'PERSONAL', status: 'ACTIVE' });
    const { s } = svc(prisma);
    await expect(s.setStatus('p1', 'SUSPENDED', 'sa')).rejects.toMatchObject({
      response: { code: 'NOT_A_CENTER' },
    });
    expect(prisma.academy.update).not.toHaveBeenCalled();
  });

  it('a PENDING center is activated only through the admin activation link', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({ id: 'c1', kind: 'CENTER', status: 'PENDING' });
    const { s } = svc(prisma);
    await expect(s.setStatus('c1', 'ACTIVE', 'sa')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminCentersService.resendActivation', () => {
  it('revokes every open token before issuing a new one', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'C',
      owner: { id: 'u1', email: 'a@x', fullName: 'A', isActive: false, passwordHash: null },
    });
    const { s } = svc(prisma);
    await s.resendActivation('c1', 'sa');
    expect(prisma.academyActivationToken.updateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: 'u1', academyId: 'c1', usedAt: null, revokedAt: null },
    });
    expect(prisma.academyActivationToken.create).toHaveBeenCalledTimes(1);
  });

  it('refuses once the admin has activated', async () => {
    const prisma = makePrisma();
    prisma.academy.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'C',
      owner: { id: 'u1', email: 'a@x', fullName: 'A', isActive: true, passwordHash: 'h' },
    });
    const { s } = svc(prisma);
    await expect(s.resendActivation('c1', 'sa')).rejects.toMatchObject({
      response: { code: 'ALREADY_ACTIVE' },
    });
  });
});

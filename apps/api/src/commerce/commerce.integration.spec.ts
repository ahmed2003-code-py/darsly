import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LiveScope, LiveService } from '../live/live.service';
import { dailyProviders } from '../live/providers/testing';
import { CommercialTermsService } from './commercial-terms.service';

/**
 * Commerce A against a real PostgreSQL: the constraints and the trigger are
 * the database's, so only a database can prove them. Skipped when none is
 * reachable at DATABASE_URL, like every *.integration.spec here.
 */
const prisma = new PrismaService();
const terms = new CommercialTermsService(prisma);
let available = true;

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.commercialTerms.count();
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

async function academy(
  kind: 'PERSONAL' | 'CENTER' = 'PERSONAL',
  teacherSharePercent: number | null = null,
) {
  const k = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `ct-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({
    data: { userId: user.id, slug: `ct-${k}`, status: 'APPROVED' },
  });
  const personal = await prisma.academy.create({
    data: { id: tp.id, slug: `ct-${k}`, name: `A ${k}`, ownerUserId: user.id },
  });
  await prisma.academyMembership.create({
    data: {
      userId: user.id,
      academyId: personal.id,
      role: 'OWNER',
      status: 'ACTIVE',
      joinedAt: new Date(),
    },
  });
  let academyId = personal.id;
  if (kind === 'CENTER') {
    const c = await prisma.academy.create({
      data: {
        slug: `cc-${k}`,
        name: `C ${k}`,
        kind: 'CENTER',
        ownerUserId: user.id,
        teacherSharePercent,
      },
    });
    await prisma.academyMembership.create({
      data: {
        userId: user.id,
        academyId: c.id,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    academyId = c.id;
  }
  return { user, tp, academyId };
}

function liveService() {
  const academyStub = {
    assertAssignableTeacher: async (_academyId: string, userId: string) => {
      const tp = await prisma.teacherProfile.findUniqueOrThrow({ where: { userId } });
      return { userId, teacherProfileId: tp.id };
    },
  };
  return new LiveService(
    prisma,
    { create: async () => ({}) } as any,
    {} as any,
    dailyProviders({}),
    { emitToLive: () => undefined, emitToUser: () => undefined } as any,
    {} as any,
    academyStub as any,
    undefined,
    terms,
  );
}
const inAnHour = () =>
  new Date(Date.now() + 3600_000 + Math.floor(Math.random() * 1e8)).toISOString();

describe('CommercialTerms on Postgres', () => {
  it('ships a platform default of 20% additive, which is what academies pay today', async () => {
    if (!guard()) return;
    const def = await prisma.commercialTerms.findUnique({
      where: { id: 'ct_platform_default_v1' },
    });
    expect(def).toMatchObject({
      academyId: null,
      feeType: 'PERCENT',
      feeBps: 2000,
      feeMode: 'ADDITIVE',
    });
  });

  it('refuses to edit a version — a change is a new row', async () => {
    if (!guard()) return;
    const a = await academy();
    const v = await terms.createVersion(
      a.academyId,
      { feeType: 'PERCENT', feeBps: 1000, feeMode: 'ADDITIVE' },
      a.user.id,
    );
    await expect(
      prisma.commercialTerms.update({ where: { id: v.id }, data: { feeBps: 1 } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "CommercialTerms" SET "feeBps" = 5 WHERE id = ${v.id}`,
    ).rejects.toThrow(/immutable/);
  });

  it('refuses impossible shapes at the database, not only in code', async () => {
    if (!guard()) return;
    const bad = [
      {
        feeType: 'PERCENT' as const,
        feeBps: null,
        feeFixedCents: null,
        feeMode: 'ADDITIVE' as const,
      },
      { feeType: 'PERCENT' as const, feeBps: 100, feeFixedCents: 5, feeMode: 'ADDITIVE' as const },
      {
        feeType: 'PERCENT' as const,
        feeBps: 10_001,
        feeFixedCents: null,
        feeMode: 'ADDITIVE' as const,
      },
      {
        feeType: 'PERCENT' as const,
        feeBps: 10_000,
        feeFixedCents: null,
        feeMode: 'DEDUCTED' as const,
      },
      { feeType: 'FIXED' as const, feeBps: null, feeFixedCents: -1, feeMode: 'ADDITIVE' as const },
      { feeType: 'FIXED' as const, feeBps: 5, feeFixedCents: 500, feeMode: 'ADDITIVE' as const },
    ];
    for (const data of bad) {
      await expect(prisma.commercialTerms.create({ data })).rejects.toThrow();
    }
  });

  it('resolves the academy’s own latest started version, else the platform default', async () => {
    if (!guard()) return;
    const a = await academy();
    expect((await terms.effectiveFor(a.academyId)).academyId).toBeNull();
    const v1 = await terms.createVersion(
      a.academyId,
      { feeType: 'PERCENT', feeBps: 1500, feeMode: 'ADDITIVE' },
      a.user.id,
    );
    expect((await terms.effectiveFor(a.academyId)).id).toBe(v1.id);
    // A version that starts tomorrow does not apply today…
    const future = await terms.createVersion(
      a.academyId,
      {
        feeType: 'FIXED',
        feeFixedCents: 900,
        feeMode: 'DEDUCTED',
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      },
      a.user.id,
    );
    expect((await terms.effectiveFor(a.academyId)).id).toBe(v1.id);
    // …and does from then on, without editing the old one.
    expect((await terms.effectiveFor(a.academyId, new Date(Date.now() + 2 * 86_400_000))).id).toBe(
      future.id,
    );
    expect((await prisma.commercialTerms.findUniqueOrThrow({ where: { id: v1.id } })).feeBps).toBe(
      1500,
    );
  });

  it('refuses a backdated version', async () => {
    if (!guard()) return;
    const a = await academy();
    await expect(
      terms.createVersion(
        a.academyId,
        {
          feeType: 'PERCENT',
          feeBps: 100,
          feeMode: 'ADDITIVE',
          effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
        },
        a.user.id,
      ),
    ).rejects.toMatchObject({ response: { code: 'COMMERCIAL_TERMS_INVALID' } });
  });
});

describe('FREE / PAID sessions on Postgres', () => {
  it('every session is FREE unless made PAID, and the database refuses a price on a FREE one', async () => {
    if (!guard()) return;
    const a = await academy();
    const svc = liveService();
    const scope: LiveScope = {
      academyId: a.academyId,
      userId: a.user.id,
      manageAll: true,
      role: 'OWNER',
    };
    const free = await svc.create(scope, { title: 'مجانية', startsAt: inAnHour() });
    expect(free).toMatchObject({ accessMode: 'FREE', priceCents: null });
    await expect(
      prisma.liveSession.update({ where: { id: free.id }, data: { priceCents: 5000 } }),
    ).rejects.toThrow();
    await expect(
      prisma.liveSession.update({ where: { id: free.id }, data: { accessMode: 'PAID' } }),
    ).rejects.toThrow();
  });

  it('creates a PAID session only with a valid price, and prices it under the academy’s terms', async () => {
    if (!guard()) return;
    const a = await academy();
    const svc = liveService();
    const scope: LiveScope = {
      academyId: a.academyId,
      userId: a.user.id,
      manageAll: true,
      role: 'OWNER',
    };
    await expect(
      svc.create(scope, { title: 'مدفوعة', startsAt: inAnHour(), accessMode: 'PAID' }),
    ).rejects.toMatchObject({
      response: {
        code: 'LIVE_SESSION_INVALID',
        fields: [expect.objectContaining({ field: 'priceCents', code: 'PRICE_REQUIRED' })],
      },
    });
    await expect(
      svc.create(scope, {
        title: 'مدفوعة',
        startsAt: inAnHour(),
        accessMode: 'PAID',
        priceCents: 10_000,
        joinUrl: 'https://meet.example/x',
      }),
    ).rejects.toMatchObject({
      response: { fields: [expect.objectContaining({ code: 'PAID_NEEDS_DARSLY_CLASSROOM' })] },
    });
    const paid = await svc.create(scope, {
      title: 'مدفوعة',
      startsAt: inAnHour(),
      accessMode: 'PAID',
      priceCents: 10_000,
    });
    expect(paid).toMatchObject({ accessMode: 'PAID', priceCents: 10_000 });
    const preview = await svc.pricePreview(scope, 10_000, null);
    expect(preview).toMatchObject({
      studentPaysCents: 12_000,
      feeCents: 2_000,
      teacherCents: 10_000,
      centerCents: 0,
    });
  });

  it('refuses a price the terms cannot sell, and a Center with no agreed split', async () => {
    if (!guard()) return;
    const a = await academy();
    await terms.createVersion(
      a.academyId,
      { feeType: 'FIXED', feeFixedCents: 5_000, feeMode: 'DEDUCTED' },
      a.user.id,
    );
    const svc = liveService();
    const scope: LiveScope = {
      academyId: a.academyId,
      userId: a.user.id,
      manageAll: true,
      role: 'OWNER',
    };
    await expect(
      svc.create(scope, {
        title: 'رخيصة',
        startsAt: inAnHour(),
        accessMode: 'PAID',
        priceCents: 4_000,
      }),
    ).rejects.toMatchObject({ response: { code: 'FEE_EXCEEDS_PRICE' } });

    const c = await academy('CENTER', null);
    const cscope: LiveScope = {
      academyId: c.academyId,
      userId: c.user.id,
      manageAll: true,
      role: 'OWNER',
    };
    await expect(
      svc.create(cscope, {
        title: 'سنتر',
        startsAt: inAnHour(),
        accessMode: 'PAID',
        priceCents: 10_000,
      }),
    ).rejects.toMatchObject({ response: { code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED' } });
    // A FREE Center session needs no split.
    await expect(
      svc.create(cscope, { title: 'سنتر مجاني', startsAt: inAnHour() }),
    ).resolves.toMatchObject({ accessMode: 'FREE' });
  });

  it('splits a Center price after the fee', async () => {
    if (!guard()) return;
    const c = await academy('CENTER', 70);
    await terms.createVersion(
      c.academyId,
      { feeType: 'PERCENT', feeBps: 1000, feeMode: 'DEDUCTED' },
      c.user.id,
    );
    const svc = liveService();
    const scope: LiveScope = {
      academyId: c.academyId,
      userId: c.user.id,
      manageAll: true,
      role: 'OWNER',
    };
    expect(await svc.pricePreview(scope, 10_000, null)).toMatchObject({
      kind: 'CENTER',
      studentPaysCents: 10_000,
      feeCents: 1_000,
      teacherCents: 6_300,
      centerCents: 2_700,
      teacherSharePercent: 70,
    });
  });
});

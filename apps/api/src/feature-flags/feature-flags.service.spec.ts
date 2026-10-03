import { FEATURE_FLAG_KEYS, FeatureFlagsService } from './feature-flags.service';

function makePrisma() {
  const rows = new Map<
    string,
    {
      id: string;
      academyId: string;
      key: string;
      enabled: boolean;
      updatedAt: Date;
      updatedBy: string | null;
    }
  >();
  let seq = 0;
  return {
    academyFeatureFlag: {
      findUnique: jest.fn(({ where: { academyId_key } }: any) =>
        Promise.resolve(rows.get(`${academyId_key.academyId}:${academyId_key.key}`) ?? null),
      ),
      findMany: jest.fn(({ where: { academyId } }: any) =>
        Promise.resolve([...rows.values()].filter((r) => r.academyId === academyId)),
      ),
      upsert: jest.fn(({ where: { academyId_key }, create, update }: any) => {
        const k = `${academyId_key.academyId}:${academyId_key.key}`;
        const existing = rows.get(k);
        // Prisma stamps @updatedAt on every create and update.
        const updatedAt = new Date();
        const row = existing
          ? { ...existing, ...update, updatedAt }
          : { id: `flag${++seq}`, ...create, updatedAt };
        rows.set(k, row);
        return Promise.resolve(row);
      }),
    },
  };
}

describe('FeatureFlagsService', () => {
  it('defaults an unset flag to enabled', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    expect(await svc.isEnabled('acad1', 'attendance')).toBe(true);
  });

  it('reflects an explicit disable', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    await svc.setFlag('acad1', 'attendance', false, 'admin1');
    expect(await svc.isEnabled('acad1', 'attendance')).toBe(false);
  });

  it('re-enabling after a disable takes effect immediately (cache invalidation)', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    await svc.setFlag('acad1', 'attendance', false, 'admin1');
    expect(await svc.isEnabled('acad1', 'attendance')).toBe(false);
    await svc.setFlag('acad1', 'attendance', true, 'admin1');
    expect(await svc.isEnabled('acad1', 'attendance')).toBe(true);
  });

  it('flags are isolated per academy', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    await svc.setFlag('acad1', 'attendance', false, 'admin1');
    expect(await svc.isEnabled('acad1', 'attendance')).toBe(false);
    expect(await svc.isEnabled('acad2', 'attendance')).toBe(true);
  });

  it('listForAcademy fills in defaults for every known key, not just ones with rows', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    await svc.setFlag('acad1', 'scheduling', false, 'admin1');
    const list = await svc.listForAcademy('acad1');
    expect(list).toHaveLength(FEATURE_FLAG_KEYS.length);
    expect(list.find((f) => f.key === 'scheduling')).toEqual({
      key: 'scheduling',
      enabled: false,
      savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    // Never saved: the default, and the switch says so (savedAt null).
    expect(list.find((f) => f.key === 'attendance')).toEqual({
      key: 'attendance',
      enabled: true,
      savedAt: null,
    });
    // A brand-new surface starts off: no row means OFF for it, unlike the gates on existing features.
    expect(list.find((f) => f.key === 'studentRegistry')).toEqual({
      key: 'studentRegistry',
      enabled: false,
      savedAt: null,
    });
  });

  it('studentRegistry is off until a platform admin turns it on, per academy', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    expect(await svc.isEnabled('acad1', 'studentRegistry')).toBe(false);
    await svc.setFlag('acad1', 'studentRegistry', true, 'admin1');
    expect(await svc.isEnabled('acad1', 'studentRegistry')).toBe(true);
    expect(await svc.isEnabled('acad2', 'studentRegistry')).toBe(false);
  });

  it('classOperations (C2) is off until a platform admin turns it on, per academy', async () => {
    const prisma = makePrisma();
    const svc = new FeatureFlagsService(prisma as any);
    expect(await svc.isEnabled('acad1', 'classOperations')).toBe(false);
    await svc.setFlag('acad1', 'classOperations', true, 'admin1');
    expect(await svc.isEnabled('acad1', 'classOperations')).toBe(true);
    expect(await svc.isEnabled('acad2', 'classOperations')).toBe(false);
  });
});

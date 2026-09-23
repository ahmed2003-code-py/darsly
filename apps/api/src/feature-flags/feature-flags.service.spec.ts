import { FeatureFlagsService } from './feature-flags.service';

function makePrisma() {
  const rows = new Map<
    string,
    { id: string; academyId: string; key: string; enabled: boolean; updatedBy: string | null }
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
        const row = existing ? { ...existing, ...update } : { id: `flag${++seq}`, ...create };
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
    expect(list).toHaveLength(5);
    expect(list.find((f) => f.key === 'scheduling')).toEqual({ key: 'scheduling', enabled: false });
    expect(list.find((f) => f.key === 'attendance')).toEqual({ key: 'attendance', enabled: true });
  });
});

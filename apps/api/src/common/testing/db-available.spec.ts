import { databaseReady } from './db-available';

/**
 * The probe has one job the old one did not do: notice that the database is
 * reachable but *wrong*. That is not hypothetical — a local database behind on
 * migrations turned an integration suite red with
 * `The column User.adminThemePreference does not exist in the current
 * database`, which is a fact about a laptop, reported as ten failing tests.
 */
function prismaStub(over: Record<string, unknown> = {}) {
  return {
    $connect: jest.fn().mockResolvedValue(undefined),
    xpRule: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    ...over,
  } as any;
}

describe('databaseReady', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('is true when every probed model can be read', async () => {
    const prisma = prismaStub();

    await expect(databaseReady(prisma, ['xpRule', 'user'])).resolves.toBe(true);
    expect(prisma.user.findFirst).toHaveBeenCalled();
  });

  it('is false when nothing is listening', async () => {
    const prisma = prismaStub({ $connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });

    await expect(databaseReady(prisma, ['xpRule'])).resolves.toBe(false);
  });

  /**
   * The case the old `count()` probe passed and should not have.
   */
  it('is false when a model is missing a column the client expects', async () => {
    const prisma = prismaStub({
      user: {
        findFirst: jest
          .fn()
          .mockRejectedValue(new Error('The column User.adminThemePreference does not exist')),
      },
    });

    await expect(databaseReady(prisma, ['xpRule', 'user'])).resolves.toBe(false);
  });

  it('says how to fix it, rather than only that it skipped', async () => {
    const warn = jest.spyOn(console, 'warn');
    const prisma = prismaStub({
      user: { findFirst: jest.fn().mockRejectedValue(new Error('column missing')) },
    });

    await databaseReady(prisma, ['user']);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prisma migrate deploy'));
  });

  it('is false for a model name that does not exist, rather than silently passing', async () => {
    const prisma = prismaStub();

    await expect(databaseReady(prisma, ['nope'])).resolves.toBe(false);
  });

  it('probes every model asked for, not just the first', async () => {
    const prisma = prismaStub();

    await databaseReady(prisma, ['xpRule', 'user']);

    expect(prisma.xpRule.findFirst).toHaveBeenCalled();
    expect(prisma.user.findFirst).toHaveBeenCalled();
  });
});

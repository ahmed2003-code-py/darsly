import { BadRequestException } from '@nestjs/common';
import {
  assertSplitConfigured,
  computeSplit,
  resolveTeacherSharePercent,
  SPLIT_NOT_CONFIGURED,
} from './revenue-split';

function makeDb(over: Record<string, unknown> = {}) {
  return {
    academy: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'centerA', kind: 'CENTER', teacherSharePercent: null }),
    },
    teacherProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'tu' }) },
    academyMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    ...over,
  } as any;
}

describe('resolveTeacherSharePercent', () => {
  it('a PERSONAL academy has no split concept — always null', async () => {
    const db = makeDb({ academy: { findUnique: jest.fn() } });
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 't1', kind: 'PERSONAL', teacherSharePercent: null },
      't1',
    );
    expect(pct).toBeNull();
  });

  it('a per-membership override wins over the Center default', async () => {
    const db = makeDb({
      academyMembership: { findFirst: jest.fn().mockResolvedValue({ revenueSharePercent: 70 }) },
    });
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 'centerA', kind: 'CENTER', teacherSharePercent: 50 },
      'tp1',
    );
    expect(pct).toBe(70);
  });

  it('falls back to the Center default when no override exists', async () => {
    const db = makeDb();
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 'centerA', kind: 'CENTER', teacherSharePercent: 60 },
      'tp1',
    );
    expect(pct).toBe(60);
  });

  it('null when neither an override nor a Center default exists — no invented percentage', async () => {
    const db = makeDb();
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 'centerA', kind: 'CENTER', teacherSharePercent: null },
      'tp1',
    );
    expect(pct).toBeNull();
  });

  it('clamps an out-of-range configured value into 0–100', async () => {
    const db = makeDb();
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 'centerA', kind: 'CENTER', teacherSharePercent: 250 },
      'tp1',
    );
    expect(pct).toBe(100);
  });

  it('an author with no TeacherProfile (should not happen, but defensively) still resolves the Center default', async () => {
    const db = makeDb({ teacherProfile: { findUnique: jest.fn().mockResolvedValue(null) } });
    const pct = await resolveTeacherSharePercent(
      db,
      { id: 'centerA', kind: 'CENTER', teacherSharePercent: 40 },
      'ghost',
    );
    expect(pct).toBe(40);
    expect(db.academyMembership.findFirst).not.toHaveBeenCalled();
  });
});

describe('assertSplitConfigured', () => {
  it('a free course is never gated — no split needed', async () => {
    const db = makeDb({ academy: { findUnique: jest.fn() } });
    await expect(
      assertSplitConfigured(db, { tenantId: 't1', academyId: 'centerA', priceCents: 0 }),
    ).resolves.toBeUndefined();
    expect(db.academy.findUnique).not.toHaveBeenCalled();
  });

  it('a PERSONAL course is never gated regardless of price', async () => {
    const db = makeDb({
      academy: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 't1', kind: 'PERSONAL', teacherSharePercent: null }),
      },
    });
    await expect(
      assertSplitConfigured(db, { tenantId: 't1', academyId: null, priceCents: 5000 }),
    ).resolves.toBeUndefined();
  });

  it('a paid Center course with no configured split throws SPLIT_NOT_CONFIGURED', async () => {
    const db = makeDb();
    await expect(
      assertSplitConfigured(db, { tenantId: 'tp1', academyId: 'centerA', priceCents: 1000 }),
    ).rejects.toMatchObject({ response: SPLIT_NOT_CONFIGURED });
  });

  it('a paid Center course with a configured split passes', async () => {
    const db = makeDb({
      academy: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'centerA', kind: 'CENTER', teacherSharePercent: 55 }),
      },
    });
    await expect(
      assertSplitConfigured(db, { tenantId: 'tp1', academyId: 'centerA', priceCents: 1000 }),
    ).resolves.toBeUndefined();
  });

  it('never invents a default percentage when unset — always the typed refusal, never a silent split', async () => {
    const db = makeDb();
    try {
      await assertSplitConfigured(db, { tenantId: 'tp1', academyId: 'centerA', priceCents: 1000 });
      fail('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as any).response.code).toBe('CENTER_REVENUE_SPLIT_NOT_CONFIGURED');
    }
  });
});

describe('computeSplit', () => {
  it('PERSONAL: the whole net goes to the teacher, nothing to the organisation', async () => {
    const db = makeDb({
      academy: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 't1', kind: 'PERSONAL', teacherSharePercent: null }),
      },
    });
    const split = await computeSplit(db, { tenantId: 't1', academyId: null }, 10_000);
    expect(split).toMatchObject({ kind: 'PERSONAL', teacherCents: 10_000, academyCents: 0 });
  });

  it('CENTER: splits the net by the configured percentage, and the two halves always sum to the net', async () => {
    const db = makeDb({
      academy: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'centerA', kind: 'CENTER', teacherSharePercent: 30 }),
      },
    });
    const split = await computeSplit(db, { tenantId: 'tp1', academyId: 'centerA' }, 10_000);
    expect(split.teacherCents).toBe(3_000);
    expect(split.academyCents).toBe(7_000);
    expect(split.teacherCents + split.academyCents).toBe(10_000);
  });

  it('CENTER with no configured split throws rather than guessing a percentage', async () => {
    const db = makeDb();
    await expect(
      computeSplit(db, { tenantId: 'tp1', academyId: 'centerA' }, 10_000),
    ).rejects.toMatchObject({ response: SPLIT_NOT_CONFIGURED });
  });

  it('rounding: an odd split still sums exactly to the net (remainder goes to the organisation)', async () => {
    const db = makeDb({
      academy: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'centerA', kind: 'CENTER', teacherSharePercent: 33 }),
      },
    });
    const split = await computeSplit(db, { tenantId: 'tp1', academyId: 'centerA' }, 1_001);
    expect(split.teacherCents + split.academyCents).toBe(1_001);
  });
});

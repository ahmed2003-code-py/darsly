import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CouponsService } from './coupons.service';

/**
 * The coupon rules, now testable without an HTTP request — which is the point
 * of moving them out of the controller.
 *
 * Four of them are worth pinning because each protects something a teacher
 * would notice: you cannot stack a percentage and a fixed amount, you cannot
 * attach a coupon to a course you do not own, a deleted code becomes free
 * again, and a coupon somebody has already used is never destroyed.
 */
function makePrisma(over: Record<string, unknown> = {}) {
  return {
    coupon: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', tenantId: 'academyA', usedCount: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    course: { findFirst: jest.fn().mockResolvedValue({ id: 'course1' }) },
    ...over,
  } as any;
}

const valid = { code: 'eid2026', percentOff: 20 };

describe('CouponsService.create', () => {
  it('requires a discount of some kind', async () => {
    const svc = new CouponsService(makePrisma());

    await expect(svc.create('academyA', { code: 'X1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses both a percentage and a fixed amount', async () => {
    const svc = new CouponsService(makePrisma());

    await expect(
      svc.create('academyA', { code: 'X1', percentOff: 10, amountOffCents: 500 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalises the code to upper case and trims it', async () => {
    const prisma = makePrisma();

    const coupon = await new CouponsService(prisma).create('academyA', { ...valid, code: '  eid2026 ' });

    expect(coupon.code).toBe('EID2026');
  });

  /** Scoped to the academy, so somebody else's course is "not found". */
  it('refuses a course this academy does not own', async () => {
    const prisma = makePrisma();
    prisma.course.findFirst.mockResolvedValue(null);
    const svc = new CouponsService(prisma);

    await expect(svc.create('academyA', { ...valid, courseId: 'someone-elses' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.coupon.create).not.toHaveBeenCalled();
  });

  it('scopes the course lookup to the caller’s academy', async () => {
    const prisma = makePrisma();

    await new CouponsService(prisma).create('academyA', { ...valid, courseId: 'course1' });

    expect(prisma.course.findFirst).toHaveBeenCalledWith({
      where: { id: 'course1', tenantId: 'academyA' },
    });
  });

  it('refuses a code that is already live', async () => {
    const prisma = makePrisma();
    prisma.coupon.findUnique.mockResolvedValue({ id: 'old', deletedAt: null });

    await expect(new CouponsService(prisma).create('academyA', valid)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * `(tenantId, code)` is unique and the constraint still counts a
   * soft-deleted row, so without this a teacher who deletes EID2026 and makes
   * it again is refused a code that looks free to them.
   */
  it('resurrects a soft-deleted code instead of refusing it', async () => {
    const prisma = makePrisma();
    prisma.coupon.findUnique.mockResolvedValue({ id: 'old', deletedAt: new Date() });

    await new CouponsService(prisma).create('academyA', valid);

    expect(prisma.coupon.create).not.toHaveBeenCalled();
    expect(prisma.coupon.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: expect.objectContaining({ isActive: true, usedCount: 0, deletedAt: null }),
    });
  });

  it('brings it back reset, not as the coupon it used to be', async () => {
    const prisma = makePrisma();
    prisma.coupon.findUnique.mockResolvedValue({ id: 'old', deletedAt: new Date(), usedCount: 91 });

    await new CouponsService(prisma).create('academyA', { code: 'EID2026', amountOffCents: 5000 });

    const data = prisma.coupon.update.mock.calls[0][0].data;
    expect(data.usedCount).toBe(0);
    expect(data.amountOffCents).toBe(5000);
    expect(data.percentOff).toBeNull(); // the old percentage does not linger
  });
});

describe('CouponsService.remove', () => {
  it('deletes a coupon nobody has used', async () => {
    const prisma = makePrisma();

    const out = await new CouponsService(prisma).remove('academyA', 'c1');

    expect(out).toEqual({ id: 'c1', deactivated: false, deleted: true });
    expect(prisma.coupon.delete).toHaveBeenCalled();
  });

  /**
   * A used coupon is part of the record of what a student was charged. It
   * stops working; it does not disappear.
   */
  it('deactivates rather than deletes one that has been used', async () => {
    const prisma = makePrisma();
    prisma.coupon.findFirst.mockResolvedValue({ id: 'c1', tenantId: 'academyA', usedCount: 3 });

    const out = await new CouponsService(prisma).remove('academyA', 'c1');

    expect(out).toEqual({ id: 'c1', deactivated: true, deleted: false });
    expect(prisma.coupon.delete).not.toHaveBeenCalled();
    expect(prisma.coupon.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { isActive: false } });
  });

  it('404s on another academy’s coupon — never "forbidden"', async () => {
    const prisma = makePrisma();
    prisma.coupon.findFirst.mockResolvedValue(null);

    await expect(new CouponsService(prisma).remove('academyA', 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CouponsService.update', () => {
  it('is scoped by academy before it writes', async () => {
    const prisma = makePrisma();

    await new CouponsService(prisma).update('academyA', 'c1', { isActive: false });

    expect(prisma.coupon.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', tenantId: 'academyA' } });
  });

  it('turns an ISO expiry into a Date', async () => {
    const prisma = makePrisma();

    await new CouponsService(prisma).update('academyA', 'c1', { expiresAt: '2026-12-31T00:00:00.000Z' });

    expect(prisma.coupon.update.mock.calls[0][0].data.expiresAt).toBeInstanceOf(Date);
  });
});

describe('CouponsService.list', () => {
  it('only ever lists the caller’s own academy', async () => {
    const prisma = makePrisma();

    await new CouponsService(prisma).list('academyA');

    expect(prisma.coupon.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'academyA' });
  });
});

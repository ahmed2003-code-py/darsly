import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Coupon } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface CouponFields {
  code: string;
  percentOff?: number;
  amountOffCents?: number;
  courseId?: string;
  maxUses?: number;
  expiresAt?: string;
}

export interface CouponPatch {
  maxUses?: number;
  expiresAt?: string;
  isActive?: boolean;
}

/**
 * Coupon rules, moved out of the controller that was holding them.
 *
 * Four decisions lived in `coupons.controller.ts`: percent and amount are
 * mutually exclusive, a course-scoped coupon must name a course in this
 * academy, a code that belongs to a soft-deleted coupon is resurrected rather
 * than re-created, and a coupon that has been used is deactivated rather than
 * deleted. Every one of them is a rule about what a coupon *is* — none of them
 * is about HTTP — and while they lived in the controller none could be tested
 * without a request, or reused from anywhere else.
 *
 * The behaviour is unchanged, deliberately and exactly: same checks, same
 * order, same messages, same response shapes.
 */
@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  list(academyId: string) {
    return this.prisma.coupon.findMany({
      where: { tenantId: academyId },
      include: { course: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Create a coupon, or bring back one that was deleted under the same code.
   *
   * The resurrection is not a nicety. `(tenantId, code)` is unique and the
   * constraint still counts a soft-deleted row, so a teacher who deletes
   * `EID2026` and makes it again would otherwise be refused a code that
   * appears, to them, to be free. It comes back reset — usage zeroed, active
   * again — because they are making a new coupon, not restoring an old one.
   */
  async create(academyId: string, dto: CouponFields): Promise<Coupon> {
    if (!dto.percentOff && !dto.amountOffCents) {
      throw new BadRequestException('Provide percentOff or amountOffCents');
    }
    if (dto.percentOff && dto.amountOffCents) {
      throw new BadRequestException('Provide either percentOff or amountOffCents, not both');
    }
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, tenantId: academyId },
      });
      // Scoped to this academy, so naming somebody else's course is a 404
      // rather than a coupon quietly attached to a course they do not own.
      if (!course) throw new NotFoundException('Course not found');
    }

    const code = dto.code.trim().toUpperCase();
    // findUnique deliberately bypasses the soft-delete filter (see
    // prisma.service.ts), which is what makes the dead row visible here.
    const existing = await this.prisma.coupon.findUnique({
      where: { tenantId_code: { tenantId: academyId, code } },
    });
    if (existing && !existing.deletedAt) {
      throw new BadRequestException('Coupon code already exists');
    }

    const fields = {
      percentOff: dto.percentOff ?? null,
      amountOffCents: dto.amountOffCents ?? null,
      courseId: dto.courseId ?? null,
      maxUses: dto.maxUses ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    };

    return existing
      ? this.prisma.coupon.update({
          where: { id: existing.id },
          data: { ...fields, isActive: true, usedCount: 0, deletedAt: null },
        })
      : this.prisma.coupon.create({ data: { tenantId: academyId, code, ...fields } });
  }

  async update(academyId: string, id: string, dto: CouponPatch): Promise<Coupon> {
    await this.assertOwned(academyId, id);
    return this.prisma.coupon.update({
      where: { id },
      data: { ...dto, ...(dto.expiresAt ? { expiresAt: new Date(dto.expiresAt) } : {}) },
    });
  }

  /**
   * Delete, unless somebody has already used it.
   *
   * A used coupon is part of the record of what a student was charged, so it
   * is deactivated instead — the discount stops working, and the enrolments
   * that already claimed it keep something to point at. The caller is told
   * which of the two happened rather than being left to guess.
   */
  async remove(academyId: string, id: string): Promise<{ id: string; deactivated: boolean; deleted: boolean }> {
    const coupon = await this.assertOwned(academyId, id);
    if (coupon.usedCount > 0) {
      await this.prisma.coupon.update({ where: { id }, data: { isActive: false } });
      return { id, deactivated: true, deleted: false };
    }
    await this.prisma.coupon.delete({ where: { id } });
    return { id, deactivated: false, deleted: true };
  }

  /** Scoped by academy, so another academy's coupon is "not found", never "forbidden". */
  private async assertOwned(academyId: string, id: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findFirst({ where: { id, tenantId: academyId } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return coupon;
  }
}

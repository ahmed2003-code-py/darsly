import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeServiceFee } from './fee.util';

/**
 * The single price a student is ever shown.
 *
 * The platform fee is additive: an academy names its price, the student pays that
 * plus the fee, and the academy is credited its own price in full. Neither side
 * needs — or should have — the other half of that arithmetic:
 *
 *  - A **student** is buying a course for one number. Splitting it into "course
 *    price" and "platform fee" invites the question of why they are paying the
 *    platform at all, and makes two different figures (the card, the checkout)
 *    appear for the same course.
 *  - An **academy** is owed the price it set. What the platform charges on top is
 *    the platform's business, and showing it in a teacher's wallet turns every
 *    sale into a negotiation.
 *
 * Only a platform admin sees both sides. So the student-facing course price is
 * computed here — once — and every student-facing payload runs through it.
 */
@Injectable()
export class StudentPriceService {
  constructor(private readonly prisma: PrismaService) {}

  /** What the student pays for a course priced at `priceCents` by `academyId`. */
  async displayPrice(academyId: string, priceCents: number): Promise<number> {
    if (priceCents <= 0) return 0; // free stays free — no fee on a free course
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      select: { feeType: true, feeValue: true },
    });
    // Mirrors EnrollmentsService.serviceFee, including its legacy fallback, so a
    // card and its checkout can never disagree.
    const feeType = academy?.feeType ?? 'PERCENT';
    const feeValue = academy?.feeValue ?? 20;
    return priceCents + computeServiceFee(feeType, feeValue, priceCents);
  }

  /**
   * Rewrite `priceCents` in place across a list of courses, batching the academy
   * lookup so a catalogue page stays one query rather than one per row.
   */
  async applyToMany<T extends { priceCents: number }>(
    rows: T[],
    academyIdOf: (row: T) => string | null | undefined,
  ): Promise<T[]> {
    const ids = [...new Set(rows.map(academyIdOf).filter((id): id is string => !!id))];
    if (ids.length === 0) return rows;

    const academies = await this.prisma.academy.findMany({
      where: { id: { in: ids } },
      select: { id: true, feeType: true, feeValue: true },
    });
    const byId = new Map(academies.map((a) => [a.id, a]));

    return rows.map((row) => {
      if (row.priceCents <= 0) return row;
      const academy = byId.get(academyIdOf(row) ?? '');
      const feeType = academy?.feeType ?? 'PERCENT';
      const feeValue = academy?.feeValue ?? 20;
      return { ...row, priceCents: row.priceCents + computeServiceFee(feeType, feeValue, row.priceCents) };
    });
  }
}

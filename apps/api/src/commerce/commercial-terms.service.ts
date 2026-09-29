import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CommercialTerms, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveTeacherSharePercent, SPLIT_NOT_CONFIGURED } from '../payments/revenue-split';
import { MAX_PRICE_CENTS, PricingError, SplitInput, TermsSnapshot } from './pricing';

type Db = PrismaService | Prisma.TransactionClient;

export interface NewTermsInput {
  feeType: 'PERCENT' | 'FIXED';
  feeBps?: number | null;
  feeFixedCents?: number | null;
  feeMode: 'ADDITIVE' | 'DEDUCTED';
  feeRefundableOnStudentCancel?: boolean;
  /** ISO; defaults to now. Never in the past — history is not rewritten. */
  effectiveFrom?: string;
  note?: string;
}

/** A clock a minute behind the server's is not "backdating". */
const PAST_TOLERANCE_MS = 60_000;

export const toSnapshot = (t: CommercialTerms): TermsSnapshot => ({
  id: t.id,
  feeType: t.feeType,
  feeBps: t.feeBps,
  feeFixedCents: t.feeFixedCents,
  feeMode: t.feeMode,
  feeRefundableOnStudentCancel: t.feeRefundableOnStudentCancel,
});

/** A PricingError, as the typed 400 every caller returns. */
export function pricingRefusal(e: unknown): never {
  if (e instanceof PricingError) {
    throw new BadRequestException({ message: e.message, code: e.code });
  }
  throw e;
}

/**
 * Darsly's commercial agreement with an academy, versioned.
 *
 * Only a platform admin writes it (the controller is SUPER_ADMIN-only); a
 * teacher or a Center reads nothing but the effect on a price. Rows are never
 * edited — a new version is inserted, and the database refuses an UPDATE — so
 * a purchase that names a version is priced by exactly that version forever.
 */
@Injectable()
export class CommercialTermsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The version in force for an academy at `at`: its own latest that has
   * started, else the latest platform default that has. Ordered by
   * effectiveFrom, then by creation, so two versions starting at the same
   * instant resolve to the one written last.
   */
  async effectiveFor(
    academyId: string,
    at = new Date(),
    db: Db = this.prisma,
  ): Promise<CommercialTerms> {
    const order = [{ effectiveFrom: 'desc' as const }, { createdAt: 'desc' as const }];
    const own = await db.commercialTerms.findFirst({
      where: { academyId, effectiveFrom: { lte: at } },
      orderBy: order,
    });
    if (own) return own;
    const platform = await db.commercialTerms.findFirst({
      where: { academyId: null, effectiveFrom: { lte: at } },
      orderBy: order,
    });
    if (!platform) {
      // The migration seeds a default; its absence is an operator error, and
      // selling on a guessed fee would be worse than refusing.
      throw new BadRequestException({
        message: 'No commercial terms are configured',
        code: 'COMMERCIAL_TERMS_MISSING',
      });
    }
    return platform;
  }

  /**
   * How a sale's net divides for this academy and this teacher — the same
   * resolution course sales use (the membership's own agreement, then the
   * Center's default). A Center with no agreement cannot sell: refused.
   */
  async splitFor(academyId: string, tenantId: string, db: Db = this.prisma): Promise<SplitInput> {
    const academy = await db.academy.findUnique({
      where: { id: academyId },
      select: { id: true, kind: true, teacherSharePercent: true },
    });
    if (!academy) throw new NotFoundException('Academy not found');
    if (academy.kind !== 'CENTER') return { kind: 'PERSONAL' };
    const pct = await resolveTeacherSharePercent(db, academy, tenantId);
    if (pct == null) throw new BadRequestException(SPLIT_NOT_CONFIGURED);
    return { kind: 'CENTER', teacherSharePercent: pct };
  }

  /** Every version for an academy (newest first) and the platform default's, plus what is in force now. */
  async history(academyId: string | null) {
    const rows = await this.prisma.commercialTerms.findMany({
      where: { academyId },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    const effective = academyId
      ? await this.effectiveFor(academyId).catch(() => null)
      : await this.prisma.commercialTerms.findFirst({
          where: { academyId: null, effectiveFrom: { lte: new Date() } },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        });
    return {
      academyId,
      effective: effective
        ? { ...effective, inherited: academyId != null && effective.academyId == null }
        : null,
      versions: rows,
    };
  }

  /** A new version. Validates the shape the database will also check, so a refusal names what is wrong. */
  async createVersion(academyId: string | null, input: NewTermsInput, adminUserId: string) {
    if (academyId) {
      const a = await this.prisma.academy.findUnique({
        where: { id: academyId },
        select: { id: true },
      });
      if (!a) throw new NotFoundException('Academy not found');
    }
    const fail = (message: string) => {
      throw new BadRequestException({ message, code: 'COMMERCIAL_TERMS_INVALID' });
    };
    const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
    let feeBps: number | null = null;
    let feeFixedCents: number | null = null;
    if (input.feeType === 'PERCENT') {
      if (!isInt(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000)
        fail('A percentage fee is basis points from 0 to 10000 (100 = 1%)');
      if (input.feeMode === 'DEDUCTED' && (input.feeBps as number) >= 10_000)
        fail('A deducted fee must be below 100%');
      feeBps = input.feeBps as number;
    } else if (input.feeType === 'FIXED') {
      if (
        !isInt(input.feeFixedCents) ||
        input.feeFixedCents < 0 ||
        input.feeFixedCents > MAX_PRICE_CENTS
      )
        fail('A fixed fee is a whole number of piasters, zero or more');
      feeFixedCents = input.feeFixedCents as number;
    } else fail('Unknown fee type');
    if (input.feeMode !== 'ADDITIVE' && input.feeMode !== 'DEDUCTED') fail('Unknown fee mode');

    const now = Date.now();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(now);
    if (!Number.isFinite(effectiveFrom.getTime())) fail('effectiveFrom is not a date');
    if (effectiveFrom.getTime() < now - PAST_TOLERANCE_MS)
      fail(
        'Terms cannot start in the past — sales already made keep the terms they were made under',
      );

    const row = await this.prisma.commercialTerms.create({
      data: {
        academyId,
        feeType: input.feeType,
        feeBps,
        feeFixedCents,
        feeMode: input.feeMode,
        feeRefundableOnStudentCancel: input.feeRefundableOnStudentCancel === true,
        effectiveFrom,
        createdById: adminUserId,
        note: input.note?.trim().slice(0, 500) || null,
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          actorUserId: adminUserId,
          action: 'commercial-terms.create',
          entity: 'CommercialTerms',
          entityId: row.id,
          academyId,
          meta: {
            feeType: row.feeType,
            feeBps: row.feeBps,
            feeFixedCents: row.feeFixedCents,
            feeMode: row.feeMode,
            feeRefundableOnStudentCancel: row.feeRefundableOnStudentCancel,
            effectiveFrom: row.effectiveFrom.toISOString(),
          } as never,
        },
      })
      .catch(() => undefined);
    return row;
  }
}

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Where a payment's net (the price after the platform fee) goes.
 *
 * PERSONAL: all of it to the teacher — their workspace IS the organisation.
 * CENTER:   split between the Center and the authoring teacher by an explicit,
 *           configured percentage: the membership's own agreement first, then
 *           the Center's default. There is deliberately NO fallback number: a
 *           Center that has not agreed a share with a teacher cannot sell that
 *           teacher's course, and the refusal says so.
 */
export interface RevenueSplit {
  kind: 'PERSONAL' | 'CENTER';
  academyId: string;
  tenantId: string;
  teacherSharePercent: number | null; // null for PERSONAL
  teacherCents: number;
  academyCents: number; // 0 for PERSONAL
}

export const SPLIT_NOT_CONFIGURED = {
  message: 'This Center has not agreed a revenue share with the teacher yet',
  code: 'CENTER_REVENUE_SPLIT_NOT_CONFIGURED',
};

export async function resolveTeacherSharePercent(
  db: Db,
  academy: { id: string; kind: 'PERSONAL' | 'CENTER'; teacherSharePercent: number | null },
  tenantId: string,
): Promise<number | null> {
  if (academy.kind !== 'CENTER') return null;
  const author = await db.teacherProfile.findUnique({ where: { id: tenantId }, select: { userId: true } });
  const membership = author
    ? await db.academyMembership.findFirst({
        where: { academyId: academy.id, userId: author.userId, deletedAt: null },
        select: { revenueSharePercent: true },
      })
    : null;
  const pct = membership?.revenueSharePercent ?? academy.teacherSharePercent ?? null;
  if (pct == null) return null;
  return Math.min(100, Math.max(0, pct));
}

/** Throws the typed refusal when a paid CENTER sale has no agreed split. */
export async function assertSplitConfigured(
  db: Db,
  course: { tenantId: string; academyId: string | null; priceCents: number },
): Promise<void> {
  if (course.priceCents <= 0) return;
  const academy = await db.academy.findUnique({
    where: { id: course.academyId ?? course.tenantId },
    select: { id: true, kind: true, teacherSharePercent: true },
  });
  if (!academy || academy.kind !== 'CENTER') return;
  if ((await resolveTeacherSharePercent(db, academy, course.tenantId)) == null) {
    throw new BadRequestException(SPLIT_NOT_CONFIGURED);
  }
}

export async function computeSplit(db: Db, payment: { tenantId: string; academyId: string | null }, netCents: number): Promise<RevenueSplit> {
  const academyId = payment.academyId ?? payment.tenantId;
  const academy = await db.academy.findUnique({
    where: { id: academyId },
    select: { id: true, kind: true, teacherSharePercent: true },
  });
  if (!academy || academy.kind !== 'CENTER') {
    return { kind: 'PERSONAL', academyId, tenantId: payment.tenantId, teacherSharePercent: null, teacherCents: netCents, academyCents: 0 };
  }
  const pct = await resolveTeacherSharePercent(db, academy, payment.tenantId);
  if (pct == null) throw new BadRequestException(SPLIT_NOT_CONFIGURED);
  const teacherCents = Math.round((netCents * pct) / 100);
  return { kind: 'CENTER', academyId, tenantId: payment.tenantId, teacherSharePercent: pct, teacherCents, academyCents: netCents - teacherCents };
}

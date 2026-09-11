import { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Activating a BUNDLE unlocks each child course as its own enrollment.
 *
 * Access is checked per course, so a bundle enrollment on its own opens
 * nothing — every path that activates one (a free enrol, a teacher's approve,
 * a verified transfer, a settled card payment) has to fan out here, or the
 * student paid for a bundle and can watch none of it.
 */
export async function activateBundleChildren(
  db: Db,
  bundle: { id: string; tenantId: string; pricingModel: string },
  studentId: string,
  expiresAt: Date | null,
): Promise<void> {
  if (bundle.pricingModel !== 'BUNDLE') return;
  const items = await db.bundleItem.findMany({ where: { bundleId: bundle.id } });
  for (const item of items) {
    await db.enrollment.upsert({
      where: { studentId_courseId: { studentId, courseId: item.courseId } },
      update: { status: 'ACTIVE', approvedAt: new Date(), expiresAt },
      create: {
        studentId,
        courseId: item.courseId,
        tenantId: bundle.tenantId,
        status: 'ACTIVE',
        approvedAt: new Date(),
        expiresAt,
      },
    });
  }
}

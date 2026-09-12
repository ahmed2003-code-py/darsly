import { EducationStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A year filter, answered as the band it sits in.
 *
 * Students pick a year ("second secondary"); teachers and courses are filed
 * under a band ("secondary"), because that is how a teacher describes what they
 * do. Resolving between the two lives here rather than in each discovery query,
 * so neither side has to know about the other's granularity.
 */
export async function stageOfGrade(
  prisma: PrismaService,
  gradeId?: string,
): Promise<EducationStage | null> {
  if (!gradeId) return null;
  const grade = await prisma.gradeLevel.findUnique({
    where: { id: gradeId },
    select: { stage: true },
  });
  return grade?.stage ?? null;
}

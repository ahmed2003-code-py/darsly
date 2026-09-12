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

/**
 * The band to filter a marketplace by for this viewer.
 *
 * An explicit filter wins, then the student's own year, then nothing. A student
 * who never asked still gets their own year's teachers and courses rather than
 * every teacher on the platform, most of whom teach years they are not in —
 * and passing `allStages` is how they say they want to look further.
 */
export async function viewerStage(
  prisma: PrismaService,
  query: { gradeId?: string; allStages?: boolean },
  viewerUserId?: string,
): Promise<EducationStage | null> {
  if (query.allStages) return null;
  if (query.gradeId) return stageOfGrade(prisma, query.gradeId);
  if (!viewerUserId) return null;
  const student = await prisma.studentProfile.findFirst({
    where: { userId: viewerUserId },
    select: { grade: { select: { stage: true } } },
  });
  return student?.grade?.stage ?? null;
}

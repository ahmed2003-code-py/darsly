import { EducationStage, SubjectTrack } from '@prisma/client';
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

/**
 * The exact year to filter a course listing by for this viewer.
 *
 * The stage is the right grain for choosing a teacher — you pick a person who
 * teaches secondary — but the wrong one for choosing a course, where a
 * second-year student has no use for the first year's material. So teachers
 * are matched on the band and courses on the year.
 */
export async function viewerGrade(
  prisma: PrismaService,
  query: { gradeId?: string; allStages?: boolean },
  viewerUserId?: string,
): Promise<string | null> {
  if (query.allStages) return null;
  if (query.gradeId) return query.gradeId;
  if (!viewerUserId) return null;
  const student = await prisma.studentProfile.findFirst({
    where: { userId: viewerUserId },
    select: { gradeId: true },
  });
  return student?.gradeId ?? null;
}

/**
 * Which school system to filter a listing by for this viewer.
 *
 * Null for everyone the question does not apply to — visitors, staff, and the
 * students who signed up before it was asked — and those are exactly the cases
 * where filtering on it would hide the whole platform rather than half of it.
 */
export async function viewerTrack(
  prisma: PrismaService,
  viewerUserId?: string,
): Promise<SubjectTrack | null> {
  if (!viewerUserId) return null;
  const student = await prisma.studentProfile.findFirst({
    where: { userId: viewerUserId },
    select: { track: true },
  });
  return student?.track ?? null;
}

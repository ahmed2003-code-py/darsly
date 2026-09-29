import { PrismaService } from '../../prisma/prisma.service';

/** Points per student (by user id) in one class. */
export async function bonusTotals(
  prisma: PrismaService,
  sessionId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ userId: string; points: bigint }[]>`
    SELECT s."userId" AS "userId", COALESCE(SUM((e.meta->>'points')::int), 0) AS points
    FROM "GamificationEvent" e JOIN "StudentProfile" s ON s.id = e."studentId"
    WHERE e.type = 'LIVE_BONUS' AND e."entityId" = ${sessionId}
    GROUP BY s."userId"`;
  return new Map(rows.map((r) => [r.userId, Number(r.points)]));
}

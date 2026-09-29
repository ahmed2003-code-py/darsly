import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** The class is over: what was still open cannot be used any more. */
export async function expireAdmissions(
  prisma: PrismaService | Prisma.TransactionClient,
  sessionId: string,
) {
  await prisma.liveAdmissionRequest.updateMany({
    where: { sessionId, status: { in: ['PENDING', 'APPROVED'] } },
    data: { status: 'EXPIRED', decidedAt: new Date() },
  });
}

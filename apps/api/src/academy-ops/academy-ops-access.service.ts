import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Group } from '@prisma/client';
import { AcademyContext } from '../academy/academy-context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Resource-level scope on top of the academy-wide `group.manage`/
 * `attendance.mark` capabilities. Holding the capability means "I may manage
 * groups I'm assigned to"; it does not by itself mean "I may manage every
 * group in this academy" — that broader authority belongs only to OWNER
 * (which includes a platform admin acting via AcademyContext.isPlatformAdmin,
 * since buildContext resolves them as an OWNER of whichever academy the
 * request names).
 */
@Injectable()
export class AcademyOpsAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Tenant-isolated group lookup + resource-level scope check. 404s (never
   *  403s) a cross-academy id, same "don't reveal existence" convention as
   *  AcademyMembershipGuard. */
  async assertGroupAccess(ctx: AcademyContext, groupId: string): Promise<Group> {
    const group = await this.prisma.group.findFirst({ where: { id: groupId, academyId: ctx.academyId } });
    if (!group) throw new NotFoundException('Group not found');
    if (ctx.role !== 'OWNER') {
      const assigned = await this.prisma.groupAssignment.findFirst({
        where: { groupId, userId: ctx.userId },
        select: { id: true },
      });
      if (!assigned) throw new ForbiddenException('You are not assigned to this group');
    }
    return group;
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CursorPage, MAX_PAGE_SIZE } from '../common/pagination';

/** One row as this endpoint returns it — the log line plus who wrote it. */
type AuditRow = Prisma.AuditLogGetPayload<{
  include: { actor: { select: { fullName: true; role: true } } };
}>;

/** Append-only audit trail. Every privileged mutation should call log(). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phase 8: a Center Admin's own activity trail — the same table SUPER_ADMIN
   * already reads via `admin/audit-logs?academyId=`, scoped hard to ONE
   * academy (never a client-supplied id — callers pass `ctx.academyId`) and
   * cursor-paginated so a busy Center's history stays browsable.
   */
  async listForAcademy(academyId: string, opts: { take?: number; cursor?: string } = {}): Promise<CursorPage<AuditRow>> {
    const take = Math.min(Math.max(opts.take ?? 30, 1), MAX_PAGE_SIZE);
    const rows = await this.prisma.auditLog.findMany({
      where: { academyId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { actor: { select: { fullName: true, role: true } } },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async log(input: {
    actorUserId?: string;
    action: string;
    entity: string;
    entityId?: string;
    /** Academy this action belongs to, when it's academy-scoped. Left unset
     *  for platform-level or student-level actions. */
    academyId?: string | null;
    meta?: Record<string, unknown>;
    ip?: string;
  }) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        academyId: input.academyId ?? undefined,
        meta: (input.meta ?? {}) as object,
        ip: input.ip,
      },
    });
  }
}

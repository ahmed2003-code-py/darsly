import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Append-only audit trail. Every privileged mutation should call log(). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

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

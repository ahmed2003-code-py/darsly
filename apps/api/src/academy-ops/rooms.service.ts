import { Injectable, NotFoundException } from '@nestjs/common';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateRoomInput {
  name: string;
  location?: string;
  capacity?: number;
}
export interface UpdateRoomInput {
  name?: string;
  location?: string;
  capacity?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
}

/** Physical academy rooms. OWNER-only (room.manage is not granted to
 *  TEACHER/ASSISTANT by default) — enforced by the guard, not re-checked here. */
@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(ctx: AcademyContext) {
    return this.prisma.room.findMany({
      where: { academyId: ctx.academyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertRoom(ctx: AcademyContext, roomId: string) {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, academyId: ctx.academyId },
    });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  async create(ctx: AcademyContext, dto: CreateRoomInput) {
    const room = await this.prisma.room.create({
      data: {
        academyId: ctx.academyId,
        name: dto.name,
        location: dto.location,
        capacity: dto.capacity,
      },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'room.create',
      entity: 'Room',
      entityId: room.id,
      academyId: ctx.academyId,
    });
    return room;
  }

  async update(ctx: AcademyContext, roomId: string, dto: UpdateRoomInput) {
    await this.assertRoom(ctx, roomId);
    const room = await this.prisma.room.update({
      where: { id: roomId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
    });
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'room.update',
      entity: 'Room',
      entityId: roomId,
      academyId: ctx.academyId,
      meta: { ...dto },
    });
    return room;
  }
}

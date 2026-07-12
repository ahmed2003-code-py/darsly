import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateCouponDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{3,24}$/) code: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) amountOffCents?: number;
  @IsOptional() @IsString() courseId?: string;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

class UpdateCouponDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) amountOffCents?: number;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('coupons')
@ApiBearerAuth()
@Roles(Role.TEACHER)
@Controller('teacher/coupons')
export class CouponsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[teacher] List my coupons with usage' })
  list(@CurrentUser() user: JwtPayload) {
    return this.prisma.coupon.findMany({
      where: { tenantId: user.tenantId },
      include: { course: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post()
  @ApiOperation({ summary: '[teacher] Create coupon (percent or fixed amount off)' })
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCouponDto) {
    if (!dto.percentOff && !dto.amountOffCents) {
      throw new BadRequestException('Provide percentOff or amountOffCents');
    }
    if (dto.percentOff && dto.amountOffCents) {
      throw new BadRequestException('Provide either percentOff or amountOffCents, not both');
    }
    if (dto.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: dto.courseId, tenantId: user.tenantId },
      });
      if (!course) throw new NotFoundException('Course not found');
    }
    const code = dto.code.trim().toUpperCase();
    // findUnique deliberately bypasses the soft-delete filter, so it also finds
    // a soft-deleted coupon. The (tenantId, code) unique constraint still
    // reserves the code for the dead row, so we must resurrect it rather than
    // create (which would hit P2002); a still-live coupon is a real conflict.
    const existing = await this.prisma.coupon.findUnique({
      where: { tenantId_code: { tenantId: user.tenantId!, code } },
    });
    if (existing && !existing.deletedAt) {
      throw new BadRequestException('Coupon code already exists');
    }
    const fields = {
      percentOff: dto.percentOff ?? null,
      amountOffCents: dto.amountOffCents ?? null,
      courseId: dto.courseId ?? null,
      maxUses: dto.maxUses ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    };

    const coupon = existing
      ? await this.prisma.coupon.update({
          where: { id: existing.id },
          data: { ...fields, isActive: true, usedCount: 0, deletedAt: null },
        })
      : await this.prisma.coupon.create({
          data: { tenantId: user.tenantId!, code, ...fields },
        });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'coupon.create',
      entity: 'Coupon',
      entityId: coupon.id,
      meta: { code },
    });
    return coupon;
  }

  @Patch(':id')
  @ApiOperation({ summary: '[teacher] Update coupon (limits, expiry, active)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return this.prisma.coupon.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.expiresAt ? { expiresAt: new Date(dto.expiresAt) } : {}),
      },
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: '[teacher] Delete coupon (deactivates if it was ever used)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!coupon) throw new NotFoundException('Coupon not found');
    if (coupon.usedCount > 0) {
      await this.prisma.coupon.update({ where: { id }, data: { isActive: false } });
      return { id, deactivated: true, deleted: false };
    }
    await this.prisma.coupon.delete({ where: { id } });
    return { id, deactivated: false, deleted: true };
  }
}

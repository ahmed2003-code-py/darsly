import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
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
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsOptionalId } from '../common/validation';
import { CouponsService } from './coupons.service';

class CreateCouponDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{3,24}$/) code: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) amountOffCents?: number;
  @IsOptionalId() courseId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxUses?: number;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

class UpdateCouponDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) amountOffCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) maxUses?: number;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('coupons')
@AcademyStaff('course.write')
@Controller('teacher/coupons')
export class CouponsController {
  constructor(
    private readonly coupons: CouponsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[teacher] List my coupons with usage' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.coupons.list(ctx.academyId);
  }

  @Post()
  @ApiOperation({ summary: '[teacher] Create coupon (percent or fixed amount off)' })
  async create(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateCouponDto) {
    const coupon = await this.coupons.create(ctx.academyId, dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'coupon.create',
      entity: 'Coupon',
      entityId: coupon.id,
      meta: { code: coupon.code },
    });
    return coupon;
  }

  @Patch(':id')
  @ApiOperation({ summary: '[teacher] Update coupon (limits, expiry, active)' })
  update(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(ctx.academyId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '[teacher] Delete coupon (deactivates if it was ever used)' })
  remove(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.coupons.remove(ctx.academyId, id);
  }
}

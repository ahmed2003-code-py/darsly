import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, PayoutMethod } from '@darsly/shared-types';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PayoutsService } from './payouts.service';

class AddMethodDto {
  @IsEnum(PayoutMethod) method: PayoutMethod;
  @IsObject() details: Record<string, unknown>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
class RequestPayoutDto {
  @IsInt() @Min(1) amountCents: number;
  @IsString() methodId: string;
}

@ApiTags('payouts')
@AcademyStaff('wallet.withdraw')
@Controller('teacher/payouts')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly audit: AuditService,
  ) {}

  @Get('methods')
  @ApiOperation({ summary: '[teacher] My saved payout methods' })
  methods(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    return this.payouts.listMethods(ctx.academyId);
  }

  @Post('methods')
  @ApiOperation({ summary: '[teacher] Add a payout method (bank / wallet / instapay)' })
  addMethod(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: AddMethodDto) {
    return this.payouts.addMethod(ctx.academyId, dto.method, dto.details, dto.isDefault ?? false);
  }

  @Delete('methods/:id')
  @ApiOperation({ summary: '[teacher] Remove a payout method' })
  removeMethod(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.payouts.removeMethod(ctx.academyId, id);
  }

  @Get()
  @ApiOperation({ summary: '[teacher] My payout requests' })
  list(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    return this.payouts.teacherList(ctx.academyId);
  }

  @Post()
  @ApiOperation({ summary: '[teacher] Request a payout (checks minimum + balance)' })
  async request(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: RequestPayoutDto) {
    const payout = await this.payouts.request(ctx.academyId, dto.amountCents, dto.methodId);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'payout.request',
      entity: 'PayoutRequest',
      entityId: payout.id,
      meta: { amountCents: dto.amountCents },
    });
    return payout;
  }
}

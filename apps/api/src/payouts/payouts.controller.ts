import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, PayoutMethod, Role } from '@darsly/shared-types';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
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
@ApiBearerAuth()
@Roles(Role.TEACHER)
@Controller('teacher/payouts')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService,
    private readonly audit: AuditService,
  ) {}

  @Get('methods')
  @ApiOperation({ summary: '[teacher] My saved payout methods' })
  methods(@CurrentUser() user: JwtPayload) {
    return this.payouts.listMethods(user.tenantId!);
  }

  @Post('methods')
  @ApiOperation({ summary: '[teacher] Add a payout method (bank / wallet / instapay)' })
  addMethod(@CurrentUser() user: JwtPayload, @Body() dto: AddMethodDto) {
    return this.payouts.addMethod(user.tenantId!, dto.method, dto.details, dto.isDefault ?? false);
  }

  @Delete('methods/:id')
  @ApiOperation({ summary: '[teacher] Remove a payout method' })
  removeMethod(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.payouts.removeMethod(user.tenantId!, id);
  }

  @Get()
  @ApiOperation({ summary: '[teacher] My payout requests' })
  list(@CurrentUser() user: JwtPayload) {
    return this.payouts.teacherList(user.tenantId!);
  }

  @Post()
  @ApiOperation({ summary: '[teacher] Request a payout (checks minimum + balance)' })
  async request(@CurrentUser() user: JwtPayload, @Body() dto: RequestPayoutDto) {
    const payout = await this.payouts.request(user.tenantId!, dto.amountCents, dto.methodId);
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

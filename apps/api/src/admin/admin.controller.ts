import { BadRequestException, Body, Controller, Get, Logger, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, PayoutStatus, Role, TeacherStatus } from '@darsly/shared-types';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { seedDatabase } from '../common/demo-seed';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PayoutsService } from '../payouts/payouts.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

class TeacherStatusDto {
  @IsEnum(TeacherStatus) status: TeacherStatus;
}
class ProcessPayoutDto {
  @IsEnum(PayoutStatus) status: PayoutStatus;
  @IsOptional() @IsString() note?: string;
}
class ReseedDto {
  @IsString() confirm: string;
}

/** Platform administration — SUPER_ADMIN only. */
@ApiTags('admin')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly payouts: PayoutsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * DANGER: wipes ALL data and regenerates the demo dataset. SUPER_ADMIN only,
   * requires an explicit confirm phrase. Runs in the background (fire-and-forget)
   * so the large dataset doesn't time out the request.
   */
  @Post('reseed')
  @ApiOperation({ summary: '[admin] Wipe all data and reseed the demo dataset' })
  reseed(@Body() dto: ReseedDto) {
    if (dto?.confirm !== 'WIPE-AND-RESEED') {
      throw new BadRequestException('Send { "confirm": "WIPE-AND-RESEED" } to proceed');
    }
    const logger = new Logger('Reseed');
    seedDatabase(this.prisma, (m) => logger.log(m))
      .then((s) => logger.log('reseed complete ' + JSON.stringify(s)))
      .catch((e) => logger.error('reseed failed: ' + String(e)));
    return { started: true, note: 'Wiping + reseeding in the background. Log in with Darsly@123 in ~1 min.' };
  }

  @Get('overview')
  @ApiOperation({ summary: '[admin] Platform overview: users, courses, revenue, commission' })
  overview() {
    return this.admin.overview();
  }

  @Get('teachers')
  @ApiOperation({ summary: '[admin] List teachers (filter by status)' })
  teachers(@Query('status') status?: TeacherStatus) {
    return this.admin.listTeachers(status);
  }

  @Patch('teachers/:id/status')
  @ApiOperation({ summary: '[admin] Approve / reject / suspend a teacher' })
  setStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: TeacherStatusDto) {
    return this.admin.setTeacherStatus(id, dto.status, user.sub);
  }

  @Get('payouts')
  @ApiOperation({ summary: '[admin] Payout queue (filter by status)' })
  payoutsQueue(@Query('status') status?: PayoutStatus) {
    return this.payouts.adminList(status);
  }

  @Patch('payouts/:id')
  @ApiOperation({ summary: '[admin] Advance a payout (APPROVED/PROCESSING/COMPLETED/REJECTED)' })
  processPayout(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ProcessPayoutDto) {
    return this.payouts.process(id, dto.status, user.sub, dto.note);
  }

  @Get('security-events')
  @ApiOperation({ summary: '[admin] Recent security events across all tenants' })
  security(@Query('resolved') resolved?: string) {
    return this.admin.securityEvents(resolved === undefined ? undefined : resolved === 'true');
  }

  @Get('audit-logs')
  @ApiOperation({ summary: '[admin] Recent audit log' })
  audit() {
    return this.admin.auditLogs();
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { GuardianRelationship } from '@prisma/client';
import { JwtPayload } from '@darsly/shared-types';
import { Request } from 'express';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { StaffScopeService } from '../academy/staff-scope.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GuardianAllowed } from '../common/decorators/guardian-allowed.decorator';
import { Public } from '../common/decorators/public.decorator';
import { GuardianFeesView } from '../follow-up/guardian-fees.view';
import { GuardianService } from './guardian.service';

class AddGuardianDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsString() @MaxLength(20) phone: string;
  @IsIn(['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER']) relationship: GuardianRelationship;
}

class ConsumeDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{20,100}$/) token: string;
}

/**
 * Staff managing a student's guardians — guardian.manage, and only for
 * students inside the caller's scope (checked in the service on every call).
 */
@ApiTags('guardians')
@ApiBearerAuth()
@Controller('staff')
export class GuardianStaffController {
  constructor(
    private readonly guardians: GuardianService,
    private readonly scopes: StaffScopeService,
    private readonly audit: AuditService,
  ) {}

  @Get('students/:studentId/guardians')
  @AcademyStaff('guardian.manage')
  @ApiOperation({ summary: "[staff] A student's guardians in this academy" })
  async list(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    return this.guardians.listForStudent(await this.scopes.forContext(ctx), studentId);
  }

  @Post('students/:studentId/guardians')
  @AcademyStaff('guardian.manage')
  @ApiOperation({ summary: '[staff] Add a guardian and issue their access link (shown once)' })
  async add(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('studentId') studentId: string,
    @Body() dto: AddGuardianDto,
  ) {
    const result = await this.guardians.add(await this.scopes.forContext(ctx), studentId, dto);
    await this.audit.log({
      actorUserId: u.sub,
      action: 'guardian.link.create',
      entity: 'GuardianLink',
      entityId: result.id,
      academyId: ctx.academyId,
      meta: { studentId, relationship: dto.relationship },
    });
    return result;
  }

  @Post('guardian-links/:id/token')
  @HttpCode(200)
  @AcademyStaff('guardian.manage')
  @ApiOperation({ summary: '[staff] Resend: a new access link; earlier ones stop working' })
  async rotate(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    const result = await this.guardians.rotate(await this.scopes.forContext(ctx), id);
    await this.audit.log({
      actorUserId: u.sub,
      action: 'guardian.link.rotate',
      entity: 'GuardianLink',
      entityId: id,
      academyId: ctx.academyId,
    });
    return result;
  }

  @Delete('guardian-links/:id')
  @AcademyStaff('guardian.manage')
  @ApiOperation({ summary: "[staff] Remove a guardian's access to this child" })
  async revoke(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    const result = await this.guardians.revoke(await this.scopes.forContext(ctx), id);
    await this.audit.log({
      actorUserId: u.sub,
      action: 'guardian.link.revoke',
      entity: 'GuardianLink',
      entityId: id,
      academyId: ctx.academyId,
    });
    return result;
  }
}

/** The guardian's own side: sign in with the link, then their children. */
@ApiTags('guardians')
@Controller()
export class GuardianController {
  constructor(
    private readonly guardians: GuardianService,
    private readonly guardianFees: GuardianFeesView,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('auth/guardian/consume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a guardian access link for a session' })
  consume(@Body() dto: ConsumeDto, @Req() req: Request) {
    return this.guardians.consume(dto.token, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceName: 'Guardian link',
    });
  }

  @GuardianAllowed()
  @ApiBearerAuth()
  @Get('guardian/children')
  @ApiOperation({ summary: '[guardian] My linked children, one per academy link' })
  children(@CurrentUser() u: JwtPayload) {
    return this.guardians.children(u);
  }

  @GuardianAllowed()
  @ApiBearerAuth()
  @Get('guardian/children/:linkId')
  @ApiOperation({ summary: "[guardian] One child's progress and activity in that academy" })
  async overview(@CurrentUser() u: JwtPayload, @Param('linkId') linkId: string) {
    const view = await this.guardians.overview(u, linkId);
    // C5: fees only where the academy chose to show guardians (default off).
    return { ...view, fees: await this.guardianFees.forChild(view.academy.id, view.student.id) };
  }
}

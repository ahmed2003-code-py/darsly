import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { IsBoolean } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
import { AcademySubjectsService } from './academy-subjects.service';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';

export class SetSubjectOfferedDto {
  @IsBoolean() isActive: boolean;
}

@ApiTags('academy')
@ApiBearerAuth()
@Controller()
export class AcademySubjectsController {
  constructor(
    private readonly subjects: AcademySubjectsService,
    private readonly audit: AuditService,
  ) {}

  /** Any content author needs this to pick a subject; OWNER needs it to manage. */
  @Get('academies/:slug/subjects')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('course.write')
  @ApiOperation({ summary: '[academy] Platform subjects with this academy\'s offered state' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.subjects.list(ctx.academyId);
  }

  /**
   * All of them, one way. Sits above the per-subject route so `subjects/all`
   * is never read as a subject id.
   */
  @Put('academies/:slug/subjects')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Offer / stop offering every platform subject (CENTER only)' })
  async setAll(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: SetSubjectOfferedDto) {
    const res = await this.subjects.setAllOffered(ctx.academyId, dto.isActive);
    await this.audit.log({
      actorUserId: user.sub, action: dto.isActive ? 'academy.subject.activateAll' : 'academy.subject.deactivateAll',
      entity: 'AcademySubject', entityId: ctx.academyId, academyId: ctx.academyId,
      meta: { count: res.count, viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return res;
  }

  @Put('academies/:slug/subjects/:subjectId')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Offer / stop offering a platform subject (CENTER only)' })
  async set(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('subjectId') subjectId: string, @Body() dto: SetSubjectOfferedDto) {
    const row = await this.subjects.setOffered(ctx.academyId, subjectId, dto.isActive);
    await this.audit.log({
      actorUserId: user.sub, action: dto.isActive ? 'academy.subject.activate' : 'academy.subject.deactivate',
      entity: 'AcademySubject', entityId: subjectId, academyId: ctx.academyId, meta: { viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return row;
  }
}

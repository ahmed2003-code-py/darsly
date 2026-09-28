import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
import { AssistantGrantDto } from './dto';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';
import { TeamService } from './team.service';

/**
 * The owner's Team screen: assistants, what each may do, which courses each
 * works on. member.manage is OWNER_ONLY, so no assistant — and no teacher
 * inside a Center — can reach any of it.
 */
@ApiTags('academy')
@ApiBearerAuth()
@Controller('academies/:slug/team')
@UseGuards(AcademyMembershipGuard, PermissionGuard)
@RequirePermission('member.manage')
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[academy] Assistants and what each may do' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.team.list(ctx.academyId);
  }

  @Get('courses')
  @ApiOperation({ summary: "[academy] This academy's courses, for choosing an assistant's" })
  courses(@CurrentAcademy() ctx: AcademyContext) {
    return this.team.courses(ctx.academyId);
  }

  @Put(':membershipId')
  @ApiOperation({ summary: "[academy] Set an assistant's title, access, courses and contact" })
  async update(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssistantGrantDto,
  ) {
    const grant = await this.team.update(ctx, membershipId, dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.assistant.update',
      entity: 'AcademyMembership',
      entityId: membershipId,
      academyId: ctx.academyId,
      meta: { ...grant, viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return grant;
  }
}

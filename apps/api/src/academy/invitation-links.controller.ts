import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
import { CreateInvitationLinkDto } from './dto';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';
import { InvitationLinksService } from './invitation-links.service';

/**
 * Shareable staff invitation links (Phase 3). Management routes are
 * Center-scoped (member.manage — OWNER only, same ceiling as direct invite);
 * preview/accept are not, since the redeemer has no Center context yet.
 */
@ApiTags('academy')
@ApiBearerAuth()
@Controller()
export class InvitationLinksController {
  constructor(
    private readonly links: InvitationLinksService,
    private readonly audit: AuditService,
  ) {}

  @Post('academies/:slug/invitation-links')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Create a single-use staff invitation link (TEACHER/ASSISTANT only)' })
  async create(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateInvitationLinkDto) {
    const link = await this.links.create(ctx.academyId, user.sub, dto.role);
    await this.audit.log({
      actorUserId: user.sub, action: 'member.invitationLink.create', entity: 'AcademyInvitationLink', entityId: link.id,
      academyId: ctx.academyId, meta: { role: link.role, expiresAt: link.expiresAt, viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return link;
  }

  @Get('academies/:slug/invitation-links')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] List invitation links (no raw tokens — those exist only at creation)' })
  list(@CurrentAcademy() ctx: AcademyContext) {
    return this.links.list(ctx.academyId);
  }

  @Delete('academies/:slug/invitation-links/:id')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Revoke an unused invitation link' })
  async revoke(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    const result = await this.links.revoke(ctx.academyId, id);
    await this.audit.log({ actorUserId: user.sub, action: 'member.invitationLink.revoke', entity: 'AcademyInvitationLink', entityId: id, academyId: ctx.academyId });
    return result;
  }

  @Public()
  @Get('invitation-links/:token')
  @ApiOperation({ summary: 'Preview a staff invitation link — Center name, role, expiry only' })
  preview(@Param('token') token: string) {
    return this.links.preview(token);
  }

  @Post('invitation-links/:token/accept')
  @ApiOperation({ summary: 'Accept a staff invitation link — explicit action, single-use' })
  async accept(@CurrentUser() user: JwtPayload, @Param('token') token: string) {
    const membership = await this.links.accept(token, user.sub);
    await this.audit.log({
      actorUserId: user.sub, action: 'member.invitationLink.accept', entity: 'AcademyMembership', entityId: membership.id, academyId: membership.academyId,
    });
    return membership;
  }

  @Post('invitation-links/:token/decline')
  @ApiOperation({ summary: 'Decline a staff invitation link — closes it, creates nothing' })
  async decline(@CurrentUser() user: JwtPayload, @Param('token') token: string) {
    const result = await this.links.decline(token, user.sub);
    await this.audit.log({
      actorUserId: user.sub, action: 'member.invitationLink.decline', entity: 'AcademyInvitationLink', entityId: result.id,
      academyId: result.academyId, meta: { role: result.role },
    });
    return { declined: true };
  }
}

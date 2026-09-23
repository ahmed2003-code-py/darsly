import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AcademyService } from './academy.service';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
import { AddMemberDto, CheckSlugDto, UpdateAcademyDto, UpdateMemberDto } from './dto';
import { AcademyMembershipGuard } from './guards/academy-membership.guard';
import { PermissionGuard } from './guards/permission.guard';
import { CAPABILITIES } from './permissions';

/**
 * Academy-aware endpoints (Phase 2). Additive only — these are NEW routes that
 * exercise the membership + permission guards; no existing route is affected.
 */
@ApiTags('academy')
@ApiBearerAuth()
@Controller()
export class AcademyController {
  constructor(
    private readonly academy: AcademyService,
    private readonly audit: AuditService,
  ) {}

  /** Every academy I belong to (for the academy switcher / home academy). */
  @Get('me/academies')
  @ApiOperation({ summary: 'List academies the current user belongs to' })
  myAcademies(@CurrentUser() user: JwtPayload) {
    return this.academy.listMyMemberships(user.sub);
  }

  /** Staff invitations waiting on my own decision — never anyone else's. */
  @Get('me/invitations')
  @ApiOperation({ summary: 'My pending academy staff invitations' })
  myInvitations(@CurrentUser() user: JwtPayload) {
    return this.academy.myInvitations(user.sub);
  }

  @Post('me/invitations/:membershipId/accept')
  @ApiOperation({ summary: 'Accept a staff invitation — I decide when I actually join' })
  async acceptInvitation(@CurrentUser() user: JwtPayload, @Param('membershipId') id: string) {
    const membership = await this.academy.acceptInvitation(user.sub, id);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.invite.accept',
      entity: 'AcademyMembership',
      entityId: id,
      academyId: membership.academyId,
    });
    return membership;
  }

  @Post('me/invitations/:membershipId/decline')
  @ApiOperation({ summary: 'Decline a staff invitation' })
  async declineInvitation(@CurrentUser() user: JwtPayload, @Param('membershipId') id: string) {
    const result = await this.academy.declineInvitation(user.sub, id);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.invite.decline',
      entity: 'AcademyMembership',
      entityId: id,
    });
    return result;
  }

  /** Public branding for an academy landing page (no membership required). */
  @Public()
  @Get('academies/:slug')
  @ApiOperation({ summary: '[public] Academy branding by slug' })
  async publicAcademy(@Param('slug') slug: string) {
    const a = await this.academy.getPublicBySlug(slug);
    if (!a) throw new NotFoundException('Academy not found');
    return a;
  }

  /** My role + effective permissions inside this academy (membership-gated). */
  @Get('academies/:slug/me')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: 'My role & permissions in this academy' })
  myContext(@CurrentAcademy() ctx: AcademyContext) {
    return {
      academyId: ctx.academyId,
      role: ctx.role,
      isPlatformAdmin: ctx.isPlatformAdmin,
      permissions: CAPABILITIES.filter((c) => ctx.can(c)),
    };
  }

  /** Public storefront: an academy's published courses (academy-first catalog). */
  @Public()
  @Get('academies/:slug/courses')
  @ApiOperation({ summary: '[public] Published courses of an academy' })
  async publicCourses(@Param('slug') slug: string) {
    const a = await this.academy.getPublicBySlug(slug);
    if (!a) throw new NotFoundException('Academy not found');
    return this.academy.publicCourses(a.id);
  }

  // ── Settings (owner: academy.manage) ──────────────────────────────────────

  @Get('academies/:slug/settings')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Full settings for the console editor' })
  settings(@CurrentAcademy() ctx: AcademyContext) {
    return this.academy.getManaged(ctx.academyId);
  }

  @Get('academies/:slug/slug-check')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({
    summary: '[academy] Is this address free? Normalizes the input and suggests alternatives',
  })
  checkSlug(@CurrentAcademy() ctx: AcademyContext, @Query() query: CheckSlugDto) {
    return this.academy.checkSlug(ctx.academyId, query.value);
  }

  @Patch('academies/:slug/settings')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Update branding & settings' })
  async updateSettings(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Body() dto: UpdateAcademyDto,
  ) {
    // No rebuild needed on a rename: the published page reads its slug from its
    // own URL, so it follows the new address on the next load.
    const updated = await this.academy.updateSettings(ctx.academyId, dto);
    // Phase 8: every settings change is auditable — field NAMES only (never
    // logo/cover data URLs, never anything that could carry PII-sized payloads).
    await this.audit.log({
      actorUserId: user.sub,
      action: 'academy.settings.update',
      entity: 'Academy',
      entityId: ctx.academyId,
      academyId: ctx.academyId,
      meta: {
        fields: Object.entries(dto)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k),
      },
    });
    return updated;
  }

  // ── Members (owner: member.manage) ────────────────────────────────────────

  @Get('academies/:slug/members')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] List members' })
  members(@CurrentAcademy() ctx: AcademyContext) {
    return this.academy.listMembers(ctx.academyId);
  }

  @Post('academies/:slug/members')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({
    summary:
      '[academy] Invite an existing user as staff (teacher/assistant) — pending until they accept',
  })
  async addMember(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Body() dto: AddMemberDto,
  ) {
    const member = await this.academy.addMember(ctx.academyId, dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.invite',
      entity: 'AcademyMembership',
      entityId: member.id,
      academyId: ctx.academyId,
      meta: { email: dto.email, role: dto.role, viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return member;
  }

  @Patch('academies/:slug/members/:membershipId')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Change a member role/status' })
  async updateMember(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('membershipId') id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    const member = await this.academy.updateMember(ctx.academyId, id, dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.update',
      entity: 'AcademyMembership',
      entityId: id,
      academyId: ctx.academyId,
      meta: { role: dto.role, status: dto.status, viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return member;
  }

  @Delete('academies/:slug/members/:membershipId')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Remove a member' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('membershipId') id: string,
  ) {
    const result = await this.academy.removeMember(ctx.academyId, id);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'member.remove',
      entity: 'AcademyMembership',
      entityId: id,
      academyId: ctx.academyId,
      meta: { viaPlatformAdmin: ctx.isPlatformAdmin },
    });
    return result;
  }
}

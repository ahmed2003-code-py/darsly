import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AcademyService } from './academy.service';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
import { AddMemberDto, UpdateAcademyDto, UpdateMemberDto } from './dto';
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
  constructor(private readonly academy: AcademyService) {}

  /** Every academy I belong to (for the academy switcher / home academy). */
  @Get('me/academies')
  @ApiOperation({ summary: 'List academies the current user belongs to' })
  myAcademies(@CurrentUser() user: JwtPayload) {
    return this.academy.listMyMemberships(user.sub);
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

  /** Example of a permission-gated academy route (exercises PermissionGuard). */
  @Get('academies/:slug/console')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('analytics.read')
  @ApiOperation({ summary: '[academy] Console home (requires analytics.read)' })
  console(@CurrentAcademy() ctx: AcademyContext) {
    return { academyId: ctx.academyId, role: ctx.role, ok: true };
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

  /** Console: all courses incl. drafts. Any staff member with course.write —
   *  proves multi-teacher/assistant management, not just the owner. */
  @Get('academies/:slug/manage/courses')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('course.write')
  @ApiOperation({ summary: '[academy] All courses incl. drafts (requires course.write)' })
  manageCourses(@CurrentAcademy() ctx: AcademyContext) {
    return this.academy.manageCourses(ctx.academyId);
  }

  // ── Settings (owner: academy.manage) ──────────────────────────────────────

  @Get('academies/:slug/settings')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Full settings for the console editor' })
  settings(@CurrentAcademy() ctx: AcademyContext) {
    return this.academy.getManaged(ctx.academyId);
  }

  @Patch('academies/:slug/settings')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[academy] Update branding & settings' })
  updateSettings(@CurrentAcademy() ctx: AcademyContext, @Body() dto: UpdateAcademyDto) {
    return this.academy.updateSettings(ctx.academyId, dto);
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
  @ApiOperation({ summary: '[academy] Add an existing user as staff (teacher/assistant)' })
  addMember(@CurrentAcademy() ctx: AcademyContext, @Body() dto: AddMemberDto) {
    return this.academy.addMember(ctx.academyId, dto);
  }

  @Patch('academies/:slug/members/:membershipId')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Change a member role/status' })
  updateMember(@CurrentAcademy() ctx: AcademyContext, @Param('membershipId') id: string, @Body() dto: UpdateMemberDto) {
    return this.academy.updateMember(ctx.academyId, id, dto);
  }

  @Delete('academies/:slug/members/:membershipId')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('member.manage')
  @ApiOperation({ summary: '[academy] Remove a member' })
  removeMember(@CurrentAcademy() ctx: AcademyContext, @Param('membershipId') id: string) {
    return this.academy.removeMember(ctx.academyId, id);
  }
}

import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AcademyService } from './academy.service';
import { AcademyContext, CurrentAcademy, RequirePermission } from './academy-context';
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
}

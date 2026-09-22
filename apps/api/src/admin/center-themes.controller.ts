import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, Matches, MaxLength } from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CenterThemesService } from './center-themes.service';

/** A namespaced look id: `preset:<id>`, `academy:<cuid>`, `cosmetic:<key>`. Shape
 *  is validated here so a malformed id never reaches the resolver. */
const THEME_ID = /^(preset|academy|cosmetic):[A-Za-z0-9_-]{1,64}$/;

export class SetCenterThemesDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(96, { each: true })
  @Matches(THEME_ID, { each: true, message: 'themeIds must be namespaced look ids' })
  themeIds: string[];
}

export class ApplyCenterThemeDto {
  @IsString() @MaxLength(96) @Matches(THEME_ID) themeId: string;
}

/** The granting side: which looks the platform offers one Center. */
@ApiTags('admin/centers')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/centers')
export class AdminCenterThemesController {
  constructor(private readonly themes: CenterThemesService) {}

  @Get(':id/themes')
  @ApiOperation({ summary: '[admin] The whole theme shelf, flagged with what this Center may use' })
  catalog(@Param('id') id: string) {
    return this.themes.catalogFor(id);
  }

  @Put(':id/themes')
  @ApiOperation({ summary: '[admin] Replace the set of themes this Center may choose from' })
  set(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetCenterThemesDto) {
    return this.themes.setGrants(id, dto.themeIds, user.sub);
  }
}

/**
 * The choosing side: the Center's own Studio.
 *
 * Gated by `academy.manage`, the same capability that already governs branding —
 * picking the organisation's look IS a branding change, and it writes the same
 * columns the settings editor writes. OWNER-only in practice, since
 * `academy.manage` is in OWNER_ONLY and cannot be granted to a teacher.
 */
@ApiTags('academy')
@ApiBearerAuth()
@Controller()
export class CenterStudioController {
  constructor(private readonly themes: CenterThemesService) {}

  @Get('academies/:slug/studio/themes')
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: '[center] The looks this Center was granted, resolved, and which one is worn' })
  mine(@CurrentAcademy() ctx: AcademyContext) {
    return this.themes.grantedFor(ctx.academyId);
  }

  @Post('academies/:slug/studio/themes/apply')
  @HttpCode(200)
  @UseGuards(AcademyMembershipGuard, PermissionGuard)
  @RequirePermission('academy.manage')
  @ApiOperation({ summary: "[center] Wear one of the granted looks — becomes the Center's brand" })
  apply(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: ApplyCenterThemeDto) {
    return this.themes.apply(ctx.academyId, dto.themeId, user.sub);
  }
}

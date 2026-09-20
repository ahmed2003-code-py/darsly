import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsIn, IsOptional } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ADMIN_THEME_IDS, AdminThemeService } from './admin-theme.service';

class SetAdminThemeDto {
  @IsOptional() @IsIn(ADMIN_THEME_IDS) themeId?: string | null;
}

/**
 * A SUPER_ADMIN's own Admin Studio theme — never a target userId in sight,
 * so every call here acts on the caller's own preference only. Separate
 * from Student Cosmetics, Academy Branding, and the Academy AI Studio —
 * this never touches any of those and is never read outside /admin/*.
 */
@ApiTags('admin/theme')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/theme')
export class AdminThemeController {
  constructor(
    private readonly theme: AdminThemeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "[admin] My own Admin Studio theme preference" })
  get(@CurrentUser() user: JwtPayload) {
    return this.theme.get(user.sub);
  }

  @Patch()
  @ApiOperation({ summary: '[admin] Set or clear my own Admin Studio theme preference' })
  async set(@CurrentUser() user: JwtPayload, @Body() dto: SetAdminThemeDto) {
    const result = await this.theme.set(user.sub, dto.themeId ?? null);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'admin_theme.set',
      entity: 'User',
      entityId: user.sub,
      meta: { themeId: result.themeId },
    });
    return result;
  }
}

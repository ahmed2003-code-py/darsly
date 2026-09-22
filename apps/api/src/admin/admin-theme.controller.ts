import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminThemeService } from './admin-theme.service';

class SetAdminThemeDto {
  /** A catalogue id only — `preset:…`, `academy:…`, `cosmetic:…`. Colours are never accepted. */
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^[A-Za-z0-9:_-]+$/) themeId?: string | null;
}

/**
 * A SUPER_ADMIN's own Admin Studio look — never a target userId in sight,
 * so every call here acts on the caller's own preference only. The
 * catalogue is read-only: choosing a Center's or a store theme's look for
 * the console never writes to that Center or that item.
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
  @ApiOperation({ summary: '[admin] My own Admin Studio look, resolved' })
  get(@CurrentUser() user: JwtPayload) {
    return this.theme.get(user.sub);
  }

  @Get('catalog')
  @ApiOperation({ summary: '[admin] Every look the console can wear: presets, every Academy brand, every store theme' })
  catalog() {
    return this.theme.catalog();
  }

  @Patch()
  @ApiOperation({ summary: '[admin] Set or clear my own Admin Studio look (by catalogue id)' })
  async set(@CurrentUser() user: JwtPayload, @Body() dto: SetAdminThemeDto) {
    const result = await this.theme.set(user.sub, dto.themeId ?? null);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'admin_theme.set',
      entity: 'User',
      entityId: user.sub,
      meta: { themeId: result.themeId, source: result.theme?.source ?? null },
    });
    return result;
  }
}

import { BadRequestException, Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsBoolean } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { FEATURE_FLAG_KEYS, FeatureFlagKey, FeatureFlagsService } from './feature-flags.service';

function assertFlagKey(key: string): asserts key is FeatureFlagKey {
  if (!(FEATURE_FLAG_KEYS as readonly string[]).includes(key)) {
    throw new BadRequestException(`Unknown feature flag: ${key}`);
  }
}

class SetFlagDto {
  @IsBoolean() enabled: boolean;
}

/** Platform admin manages per-academy feature toggles. SUPER_ADMIN only —
 *  academy staff have no visibility or control over their own flags here. */
@ApiTags('admin/feature-flags')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/academies/:academyId/feature-flags')
export class FeatureFlagsController {
  constructor(
    private readonly flags: FeatureFlagsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "[admin] An academy's feature flags (defaults filled in)" })
  list(@Param('academyId') academyId: string) {
    return this.flags.listForAcademy(academyId);
  }

  @Patch(':key')
  @ApiOperation({ summary: '[admin] Enable/disable one feature for an academy' })
  async set(
    @CurrentUser() user: JwtPayload,
    @Param('academyId') academyId: string,
    @Param('key') key: string,
    @Body() dto: SetFlagDto,
  ) {
    assertFlagKey(key);
    const row = await this.flags.setFlag(academyId, key, dto.enabled, user.sub);
    await this.audit.log({
      actorUserId: user.sub,
      action: `feature_flag.${dto.enabled ? 'enable' : 'disable'}`,
      entity: 'AcademyFeatureFlag',
      entityId: row.id,
      academyId,
      meta: { key },
    });
    return row;
  }
}

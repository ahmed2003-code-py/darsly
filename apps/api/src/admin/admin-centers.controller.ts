import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminCentersService } from './admin-centers.service';
import {
  CreateCenterDto,
  DeleteCenterDto,
  RevokeCenterAccessDto,
  SetCenterStatusDto,
} from './dto/admin-centers.dto';

@ApiTags('admin/centers')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/centers')
export class AdminCentersController {
  constructor(private readonly centers: AdminCentersService) {}

  @Post()
  @ApiOperation({
    summary:
      '[admin] Create a Center and designate its admin (new STAFF account or existing STAFF/approved teacher)',
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCenterDto) {
    return this.centers.createCenter(dto, user.sub);
  }

  @Post(':id/activation/resend')
  @ApiOperation({ summary: '[admin] Reissue the one-time activation link (revokes earlier ones)' })
  resend(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.centers.resendActivation(id, user.sub);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '[admin] Activate / suspend / archive a Center (CENTER kind only)' })
  setStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetCenterStatusDto,
  ) {
    return this.centers.setStatus(id, dto.status, user.sub);
  }

  @Get(':id/deletion-impact')
  @ApiOperation({
    summary: '[admin] What deleting this Center would hide — shown before the confirmation',
  })
  deletionImpact(@Param('id') id: string) {
    return this.centers.deletionImpact(id);
  }

  // Body on a DELETE, deliberately: the typed address is part of authorizing
  // this call, and a query string would put a Center's slug in the access log
  // of every proxy between here and the browser.
  @Delete(':id')
  @ApiOperation({
    summary: '[admin] Delete a Center (soft, reversible) — requires its address typed back',
  })
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: DeleteCenterDto) {
    return this.centers.deleteCenter(id, dto.confirmSlug, user.sub);
  }

  @Post(':id/access/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "[admin] Revoke one person's access to this Center (the owner's, with a named successor)",
  })
  revokeAccess(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RevokeCenterAccessDto,
  ) {
    return this.centers.revokeAccess(id, dto.userId, user.sub, dto.transferOwnershipTo);
  }
}

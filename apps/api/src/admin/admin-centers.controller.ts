import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminCentersService } from './admin-centers.service';
import { CreateCenterDto, SetCenterStatusDto } from './dto/admin-centers.dto';

@ApiTags('admin/centers')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/centers')
export class AdminCentersController {
  constructor(private readonly centers: AdminCentersService) {}

  @Post()
  @ApiOperation({ summary: '[admin] Create a Center and designate its admin (new STAFF account or existing STAFF/approved teacher)' })
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
  setStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetCenterStatusDto) {
    return this.centers.setStatus(id, dto.status, user.sub);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { MintEnrollmentCodeDto } from './dto';

/**
 * Admin control over listener phones: authorise a handset, see what is enrolled,
 * and cut one off. Guarded by the platform's normal user auth (SUPER_ADMIN),
 * unlike the device routes which carry device-scoped tokens.
 */
@ApiTags('device')
@ApiBearerAuth()
@Controller('admin/device')
export class DeviceAdminController {
  constructor(private readonly enrollment: DeviceEnrollmentService) {}

  /**
   * Returns the code in plaintext exactly once — it is stored only as an argon2
   * hash, so it cannot be recovered afterwards. Read it to whoever holds the
   * phone; it is single-use and expires in 15 minutes.
   */
  @Post('enrollment-codes')
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(201)
  @ApiOperation({ summary: '[admin] Mint a single-use enrollment code for a listener phone' })
  mint(@CurrentUser() user: JwtPayload, @Body() dto: MintEnrollmentCodeDto) {
    return this.enrollment.mint(dto.phone, dto.label, user.sub);
  }

  @Get('enrollment-codes')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Codes still usable (never the codes themselves)' })
  listCodes() {
    return this.enrollment.listActive();
  }

  @Get('devices')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Enrolled listener phones + how many SMS each has sent' })
  listDevices() {
    return this.enrollment.listDevices();
  }

  @Post('devices/:id/revoke')
  @Roles(Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Cut a listener phone off immediately' })
  revoke(@Param('id') id: string) {
    return this.enrollment.revoke(id, 'REVOKED_BY_ADMIN');
  }
}

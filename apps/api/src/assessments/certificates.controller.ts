import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CertificatesService } from './certificates.service';

@ApiTags('assessments')
@Controller('certificates')
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get('mine')
  @ApiBearerAuth()
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My earned certificates' })
  mine(@CurrentUser() u: JwtPayload) {
    return this.certificates.listMine(u.sub);
  }

  @Get('verify/:serial')
  @Public()
  @ApiOperation({ summary: '[public] Verify a certificate by serial' })
  verify(@Param('serial') serial: string) {
    return this.certificates.verify(serial);
  }

  @Get('mine/:serial')
  @ApiBearerAuth()
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My certificate (for the printable view)' })
  getMine(@CurrentUser() u: JwtPayload, @Param('serial') serial: string) {
    return this.certificates.getMineBySerial(u.sub, serial);
  }
}

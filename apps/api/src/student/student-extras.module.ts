import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Module } from '@nestjs/common';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { StudentExtrasService } from './student-extras.service';

@ApiTags('student')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller()
class StudentExtrasController {
  constructor(private readonly svc: StudentExtrasService) {}

  @Post('courses/:id/save')
  @ApiOperation({ summary: '[student] Save (wishlist) a course' })
  save(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.svc.save(u.sub, id);
  }

  @Delete('courses/:id/save')
  @ApiOperation({ summary: '[student] Remove a course from saved' })
  unsave(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.svc.unsave(u.sub, id);
  }

  @Get('me/saved')
  @ApiOperation({ summary: '[student] My saved courses' })
  saved(@CurrentUser() u: JwtPayload) {
    return this.svc.listSaved(u.sub);
  }

  @Get('me/saved/ids')
  @ApiOperation({ summary: '[student] Ids of my saved courses (for heart toggles)' })
  savedIds(@CurrentUser() u: JwtPayload) {
    return this.svc.savedIds(u.sub);
  }

  @Get('me/badges')
  @ApiOperation({ summary: '[student] My achievement badges (earned + locked)' })
  badges(@CurrentUser() u: JwtPayload) {
    return this.svc.badges(u.sub);
  }
}

@Module({
  controllers: [StudentExtrasController],
  providers: [StudentExtrasService],
})
export class StudentExtrasModule {}

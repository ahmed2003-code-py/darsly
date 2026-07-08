import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CoursesService } from './courses.service';

@ApiTags('courses')
@Controller('courses')
export class PublicCoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Public()
  @Get(':id')
  @ApiOperation({
    summary:
      'Public course page: curriculum with per-lesson lock state (free preview / drip / enrollment)',
  })
  detail(@Param('id') id: string, @CurrentUser() viewer?: JwtPayload) {
    return this.courses.publicDetail(id, viewer);
  }
}

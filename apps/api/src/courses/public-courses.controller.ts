import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CoursesService } from './courses.service';
import { DiscoverCoursesDto } from './dto/discover-courses.dto';

@ApiTags('courses')
@Controller('courses')
export class PublicCoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Public course catalogue: search, filter, sort, paginate' })
  // Public, but viewer-aware: a signed-in student is not shown the catalogues of
  // teachers competing with their own. The guard attaches the user on public
  // routes when a token is present, so this stays anonymous-friendly.
  discover(@Query() query: DiscoverCoursesDto, @CurrentUser() viewer?: JwtPayload) {
    return this.courses.discover(query, viewer?.sub);
  }

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

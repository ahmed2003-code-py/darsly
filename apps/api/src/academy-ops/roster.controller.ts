import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { RosterService } from './roster.service';

@ApiTags('teacher/roster')
@AcademyStaff('student.manage')
@Controller('teacher/roster')
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Get()
  @ApiOperation({ summary: '[academy] Academy-wide student roster — search + paginate' })
  list(
    @CurrentAcademy() ctx: AcademyContext,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.roster.roster(ctx.academyId, {
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }
}

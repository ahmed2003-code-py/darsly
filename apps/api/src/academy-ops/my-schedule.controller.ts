import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionsService } from './sessions.service';

const MAX_RANGE_DAYS = 92;

/**
 * The signed-in teacher's unified calendar across every workspace they teach
 * in. No academy context: the scope is the teacher themselves, and only rows
 * where they are the teacher are ever returned.
 */
@ApiTags('academy-ops')
@ApiBearerAuth()
@Controller()
export class MyScheduleController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('me/schedule')
  @ApiOperation({ summary: 'My schedule across Personal + every Center (physical + live)' })
  mySchedule(@CurrentUser() user: JwtPayload, @Query('from') from?: string, @Query('to') to?: string) {
    if (!from || !to) throw new BadRequestException('from and to are required');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate <= fromDate) {
      throw new BadRequestException('Invalid range');
    }
    if ((toDate.getTime() - fromDate.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw new BadRequestException('Range too wide');
    return this.sessions.mySchedule(user.sub, fromDate, toDate);
  }
}

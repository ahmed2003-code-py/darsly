import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsInt, Max, Min } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ProgressService } from './progress.service';

class WeeklyGoalDto {
  @IsInt() @Min(1) @Max(50) goal: number;
}

@ApiTags('progress')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller('progress')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('continue-watching')
  @ApiOperation({ summary: '[student] In-progress lessons to resume' })
  continueWatching(@CurrentUser() user: JwtPayload) {
    return this.progress.continueWatching(user.sub);
  }

  @Get('summary')
  @ApiOperation({ summary: '[student] Streak + weekly goal + totals' })
  summary(@CurrentUser() user: JwtPayload) {
    return this.progress.summary(user.sub);
  }

  @Patch('weekly-goal')
  @ApiOperation({ summary: '[student] Set my weekly lesson goal' })
  setGoal(@CurrentUser() user: JwtPayload, @Body() dto: WeeklyGoalDto) {
    return this.progress.setWeeklyGoal(user.sub, dto.goal);
  }
}

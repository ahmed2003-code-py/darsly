import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { CreateSessionDto, UpdateSessionDto } from './dto/scheduling.dto';
import { SessionsService } from './sessions.service';

@ApiTags('teacher/sessions')
@AcademyStaffFeature('schedule.manage', 'scheduling')
@Controller('teacher')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('groups/:groupId/sessions')
  @ApiOperation({ summary: '[academy] Schedule a session for a group' })
  create(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('groupId') groupId: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessions.create(ctx, groupId, dto);
  }

  @Patch('sessions/:sessionId')
  @ApiOperation({ summary: '[academy] Reschedule, change room/teacher, or cancel a session' })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessions.update(ctx, sessionId, dto);
  }
}

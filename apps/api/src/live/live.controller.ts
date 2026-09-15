import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsOptionalId, LIMITS } from '../common/validation';

/** A live session is a class, not a broadcast station: 12 hours is the ceiling. */
const MAX_DURATION_MIN = 720;
const MAX_CAPACITY = 100_000;
import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LiveService } from './live.service';

class CreateLiveDto {
  @IsString() @MinLength(2) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsISO8601() startsAt: string;
  @IsOptional() @IsInt() @Min(5) @Max(MAX_DURATION_MIN) durationMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_CAPACITY) capacity?: number | null;
  @IsOptionalId() courseId?: string | null;
  // Rendered as a link students click — anything but a real URL is a trap.
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?: string | null;
}

class UpdateLiveDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsInt() @Min(5) @Max(MAX_DURATION_MIN) durationMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_CAPACITY) capacity?: number | null;
  @IsOptionalId() courseId?: string | null;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?: string | null;
}

@ApiTags('live')
@ApiBearerAuth()
@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  // ── Teacher ──────────────────────────────────────────────────────────────

  @Get('teacher/live')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Live sessions with booking counts' })
  listMine(@CurrentAcademy() ctx: AcademyContext) {
    return this.live.listForTeacher(ctx.academyId);
  }

  @Post('teacher/live')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Schedule a live session (notifies students)' })
  create(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateLiveDto) {
    return this.live.create(ctx.academyId, dto);
  }

  @Patch('teacher/live/:id')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Update a live session' })
  update(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: UpdateLiveDto) {
    return this.live.update(ctx.academyId, id, dto);
  }

  @Delete('teacher/live/:id')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Cancel (soft-delete) a live session' })
  remove(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.remove(ctx.academyId, id);
  }

  @Get('teacher/live/:id/bookings')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Students booked for a session' })
  bookings(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.bookingsFor(ctx.academyId, id);
  }

  @Get('teacher/live/:id/attendance')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Who actually attended, and for how long' })
  attendance(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.attendanceFor(ctx.academyId, id);
  }

  /**
   * Opens the classroom and hands the teacher their own way in.
   *
   * The owner token this returns is what allows moderation, so it is minted
   * from the academy membership the guard already proved — never from anything
   * the request asked for.
   */
  @Post('teacher/live/:id/start')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Start the meeting and get an owner token' })
  start(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @CurrentUser() u: JwtPayload) {
    return this.live.start(ctx.academyId, id, u.sub);
  }

  /** Walking back into a class already running — a refresh, or a second device. */
  @Get('teacher/live/:id/join')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Re-enter a running meeting' })
  teacherJoin(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @CurrentUser() u: JwtPayload) {
    return this.live.teacherJoin(ctx.academyId, id, u.sub);
  }

  @Post('teacher/live/:id/end')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] End the meeting for everyone' })
  end(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.end(ctx.academyId, id);
  }

  // ── Student ──────────────────────────────────────────────────────────────

  @Get('live/upcoming')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Upcoming live sessions from my teachers' })
  upcoming(@CurrentUser() u: JwtPayload) {
    return this.live.upcomingForStudent(u.sub);
  }

  @Post('live/:id/book')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Book a seat' })
  book(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.book(u.sub, id);
  }

  @Delete('live/:id/book')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Cancel my booking' })
  cancel(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.cancel(u.sub, id);
  }

  /**
   * The secure door into the classroom.
   *
   * Returns a room URL and a token scoped to this student, this room and this
   * session's window — and only after the server has checked the booking, the
   * clock and that the teacher has actually started. Nothing here is decided
   * by the caller.
   */
  @Get('live/:id/join')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Enter the meeting (booked + started + within window)' })
  join(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.join(u.sub, id);
  }

  // ── Presence (either side of the classroom) ──────────────────────────────

  @Post('live/:id/heartbeat')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Still in the room — what attendance time is counted from' })
  heartbeat(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.heartbeat(u.sub, id);
  }

  @Post('live/:id/leave')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Left the room (best effort — heartbeats are the record)' })
  leave(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.leave(u.sub, id);
  }
}

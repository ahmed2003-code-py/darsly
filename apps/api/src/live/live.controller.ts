import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
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

import { JwtPayload, Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LIVE_MAX_DURATION_MIN as MAX_DURATION_MIN, LiveScope, LiveService } from './live.service';
import { LiveRtcService } from './rtc/live-rtc.service';
import { LiveRecordingService } from './recording/live-recording.service';

/**
 * Shapes and abuse caps only. The product's rules (title length, minimum and
 * maximum duration, capacity, no past start) are LIVE_SESSION_RULES, checked
 * in LiveService so a refusal names its field with a code the form can put
 * under that field — a class-validator sentence cannot be shown to a teacher.
 */
class CreateLiveDto {
  @IsString() @MaxLength(2000) title: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsISO8601() startsAt: string;
  @IsOptional() @IsInt() @Min(-1_000_000) @Max(1_000_000) durationMin?: number;
  @IsOptional() @IsInt() @Min(-1_000_000_000) @Max(1_000_000_000) capacity?: number | null;
  @IsOptionalId() courseId?: string | null;
  // Rendered as a link students click — anything but a real URL is a trap.
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?:
    string | null;
  @IsOptionalId() teacherUserId?: string | null;
  @IsOptionalId() groupId?: string | null;
}

class RecordingStartedDto {
  /** Daily's id for the recording, as the client reported it starting. */
  @IsOptional() @IsString() @MaxLength(LIMITS.ID) recordingId?: string;
}

class SummaryVisibilityDto {
  @IsBoolean() visible: boolean;
}

class ExtendLiveDto {
  /** Added to the class's current end, by the server. */
  @IsInt() @Min(1) @Max(MAX_DURATION_MIN) minutes: number;
  /**
   * The end the page was showing when the teacher pressed the button. If the
   * class was extended since (another tab, another device), the request is
   * refused with the current timing instead of adding a second extension.
   */
  @IsOptional() @IsISO8601() expectedEndsAt?: string;
}

class CancelLiveDto {
  /** Shown to the students who booked, and kept with the cancellation. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class ChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(2000) body: string;
}

class UpdateLiveDto {
  @IsOptional() @IsString() @MaxLength(2000) title?: string;
  @IsOptional() @IsString() @MaxLength(20_000) description?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsInt() @Min(-1_000_000) @Max(1_000_000) durationMin?: number;
  @IsOptional() @IsInt() @Min(-1_000_000_000) @Max(1_000_000_000) capacity?: number | null;
  @IsOptionalId() courseId?: string | null;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?:
    string | null;
  @IsOptionalId() teacherUserId?: string | null;
  @IsOptionalId() groupId?: string | null;
}

/** Organisation + authorship scope from the validated context; the body never decides either. */
const scopeOf = (ctx: AcademyContext): LiveScope => ({
  academyId: ctx.academyId,
  userId: ctx.userId,
  manageAll: ctx.role === 'OWNER',
  role: ctx.role,
});

@ApiTags('live')
@ApiBearerAuth()
@Controller()
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly rtc: LiveRtcService,
    private readonly recordings: LiveRecordingService,
  ) {}

  // ── Teacher ──────────────────────────────────────────────────────────────

  @Get('teacher/live')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Live sessions with booking counts' })
  listMine(@CurrentAcademy() ctx: AcademyContext) {
    return this.live.listForTeacher(scopeOf(ctx));
  }

  @Post('teacher/live')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Schedule a live session (notifies students)' })
  create(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateLiveDto) {
    return this.live.create(scopeOf(ctx), dto);
  }

  @Patch('teacher/live/:id')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Update a live session' })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateLiveDto,
  ) {
    return this.live.update(scopeOf(ctx), id, dto);
  }

  @Delete('teacher/live/:id')
  @AcademyStaff('live.manage')
  @ApiOperation({
    summary: '[academy] Cancel a live session (soft delete; booked students are notified)',
  })
  remove(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @CurrentUser() u: JwtPayload,
    @Body() dto: CancelLiveDto,
  ) {
    return this.live.remove(scopeOf(ctx), id, u.sub, dto?.reason);
  }

  @Get('teacher/live/:id/bookings')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Students booked for a session' })
  bookings(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.bookingsFor(scopeOf(ctx), id);
  }

  @Get('teacher/live/:id/attendance')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Who actually attended, and for how long' })
  attendance(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.attendanceFor(scopeOf(ctx), id);
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
  start(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @CurrentUser() u: JwtPayload,
  ) {
    return this.live.start(scopeOf(ctx), id, u.sub);
  }

  /** Walking back into a class already running — a refresh, or a second device. */
  @Get('teacher/live/:id/join')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Re-enter a running meeting' })
  teacherJoin(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @CurrentUser() u: JwtPayload,
  ) {
    return this.live.teacherJoin(scopeOf(ctx), id, u.sub);
  }

  /**
   * Make a running class longer. The server works out the new end from the
   * class as it is now, moves the room's expiry at the provider first, and
   * only then records it — see LiveService.extend.
   */
  @Post('teacher/live/:id/extend')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Extend a running class (room expiry moves with it)' })
  extend(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @CurrentUser() u: JwtPayload,
    @Body() dto: ExtendLiveDto,
  ) {
    return this.live.extend(scopeOf(ctx), id, dto.minutes, {
      expectedEndsAt: dto.expectedEndsAt,
      actorUserId: u.sub,
    });
  }

  @Post('teacher/live/:id/end')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] End the meeting for everyone' })
  end(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.end(scopeOf(ctx), id);
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

  // ── Recording, summary and attendance (the teacher's side) ───────────────

  /** Records that recording began, and the provider's id for it. */
  @Post('teacher/live/:id/recording/start')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Mark the session as recording' })
  async startRecording(
    @CurrentAcademy() ctx: AcademyContext,
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RecordingStartedDto,
  ) {
    const s = await this.live.ownedSession(scopeOf(ctx), id);
    // A Darsly-hosted class is recorded by Darsly's recorder; a Daily class by
    // Daily's cloud, started in the browser and only noted here.
    if (s.provider === 'CLOUDFLARE') return this.recordings.start(scopeOf(ctx), id, u.sub);
    return this.live.markRecording(scopeOf(ctx), id, dto.recordingId ?? null);
  }

  @Post('teacher/live/:id/recording/stop')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Mark recording as stopped (still processing)' })
  async stopRecording(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    const s = await this.live.ownedSession(scopeOf(ctx), id);
    if (s.provider === 'CLOUDFLARE') return this.recordings.stop(scopeOf(ctx), id);
    return this.live.stopRecording(scopeOf(ctx), id);
  }

  /** The classroom saying transcription never came up at the provider. */
  @Post('teacher/live/:id/transcription-failed')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Record that transcription could not start' })
  transcriptionFailed(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.reportTranscriptionFailure(scopeOf(ctx), id);
  }

  @Post('teacher/live/:id/summary')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Queue an AI summary of the lesson' })
  summarise(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.live.requestSummary(scopeOf(ctx), id);
  }

  @Patch('teacher/live/:id/summary/visibility')
  @AcademyStaff('live.manage')
  @ApiOperation({ summary: '[academy] Share the summary with the class, or stop sharing it' })
  shareSummary(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SummaryVisibilityDto,
  ) {
    return this.live.setSummaryVisibility(scopeOf(ctx), id, dto.visible);
  }

  // ── The classroom, for anyone admitted to it ─────────────────────────────

  /** What a viewer may read about a session: recording and summary, by role. */
  @Get('live/:id/detail')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Session detail (recording + summary, filtered by role)' })
  detail(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.sessionDetail(u.sub, id);
  }

  @Get('live/:id/chat')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Messages sent inside the classroom' })
  chat(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.chatHistory(u.sub, id);
  }

  @Post('live/:id/chat')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'Send a message to the classroom' })
  sendChat(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: ChatMessageDto) {
    return this.live.sendChat(u.sub, id, dto.body);
  }

  /** A short-lived link to the recording, minted per request. */
  @Get('live/:id/recording')
  @Roles(Role.STUDENT, Role.TEACHER)
  @ApiOperation({ summary: 'A short-lived link to watch the recording' })
  recording(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.recordingLink(u.sub, id);
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
  async leave(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    // A Cloudflare class also closes this person's connections now, rather
    // than when the SFU notices they went quiet.
    await this.rtc.leave(u.sub, id);
    return this.live.leave(u.sub, id);
  }
}

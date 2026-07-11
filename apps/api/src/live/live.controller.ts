import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LiveService } from './live.service';

class CreateLiveDto {
  @IsString() @MinLength(2) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsISO8601() startsAt: string;
  @IsOptional() @IsInt() @Min(5) durationMin?: number;
  @IsOptional() @IsInt() @Min(1) capacity?: number | null;
  @IsOptional() @IsString() courseId?: string | null;
  @IsOptional() @IsString() joinUrl?: string | null;
}

class UpdateLiveDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsInt() @Min(5) durationMin?: number;
  @IsOptional() @IsInt() @Min(1) capacity?: number | null;
  @IsOptional() @IsString() courseId?: string | null;
  @IsOptional() @IsString() joinUrl?: string | null;
}

@ApiTags('live')
@ApiBearerAuth()
@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  // ── Teacher ──────────────────────────────────────────────────────────────

  @Get('teacher/live')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] My live sessions with booking counts' })
  listMine(@CurrentUser() u: JwtPayload) {
    return this.live.listForTeacher(u.tenantId!);
  }

  @Post('teacher/live')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Schedule a live session (notifies students)' })
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateLiveDto) {
    return this.live.create(u.tenantId!, dto);
  }

  @Patch('teacher/live/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Update a live session' })
  update(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: UpdateLiveDto) {
    return this.live.update(u.tenantId!, id, dto);
  }

  @Delete('teacher/live/:id')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Cancel (soft-delete) a live session' })
  remove(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.remove(u.tenantId!, id);
  }

  @Get('teacher/live/:id/bookings')
  @Roles(Role.TEACHER)
  @ApiOperation({ summary: '[teacher] Students booked for a session' })
  bookings(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.bookingsFor(u.tenantId!, id);
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

  @Get('live/:id/join')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Get the join link (booked + within window)' })
  join(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.live.join(u.sub, id);
  }
}

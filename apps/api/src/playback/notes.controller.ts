import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

class CreateNoteDto {
  @IsInt() @Min(0) timestampSec: number;
  @IsString() @MinLength(1) body: string;
}

/** Student's private, timestamped notes on a lesson (right rail of the player). */
@ApiTags('playback')
@ApiBearerAuth()
@Roles(Role.STUDENT)
@Controller('playback')
export class NotesController {
  constructor(private readonly prisma: PrismaService) {}

  private async studentId(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!s) throw new ForbiddenException('No student profile');
    return s.id;
  }

  @Get('lessons/:lessonId/notes')
  @ApiOperation({ summary: '[student] My timestamped notes for a lesson' })
  async list(@CurrentUser() user: JwtPayload, @Param('lessonId') lessonId: string) {
    return this.prisma.videoNote.findMany({
      where: { lessonId, studentId: await this.studentId(user.sub) },
      orderBy: { timestampSec: 'asc' },
    });
  }

  @Post('lessons/:lessonId/notes')
  @ApiOperation({ summary: '[student] Add a note at the current timestamp' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateNoteDto,
  ) {
    const studentId = await this.studentId(user.sub);
    // Only allow notes on a lesson the student can actually access (avoids
    // writing junk note rows against arbitrary/unenrolled lessons).
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      include: { unit: { include: { course: { select: { id: true, deletedAt: true } } } } },
    });
    if (!lesson || lesson.unit.deletedAt || lesson.unit.course.deletedAt) {
      throw new NotFoundException('Lesson not found');
    }
    if (!lesson.isFreePreview) {
      const enr = await this.prisma.enrollment.findUnique({
        where: { studentId_courseId: { studentId, courseId: lesson.unit.course.id } },
      });
      const active = enr?.status === 'ACTIVE' && (!enr.expiresAt || enr.expiresAt > new Date());
      if (!active) throw new ForbiddenException('Not enrolled in this course');
    }
    return this.prisma.videoNote.create({
      data: { lessonId, studentId, timestampSec: dto.timestampSec, body: dto.body },
    });
  }

  @Delete('notes/:id')
  @ApiOperation({ summary: '[student] Delete one of my notes' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const note = await this.prisma.videoNote.findUnique({ where: { id } });
    if (!note || note.studentId !== (await this.studentId(user.sub))) {
      throw new NotFoundException('Note not found');
    }
    await this.prisma.videoNote.delete({ where: { id } });
    return { id, deleted: true };
  }
}

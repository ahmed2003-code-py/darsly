import { Body, Controller, Get, HttpCode, Param, Post, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsId, IsOptionalId, LIMITS } from '../common/validation';
import { examUploadInterceptor } from '../paper-import/paper-import.controller';
import { ContentScope, LiveContentService } from './live-content.service';

class NewCourseDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
  @IsId() gradeId: string;
  @IsOptionalId() subjectId?: string;
}

class PublishLessonDto {
  @IsIn(['EXISTING_COURSE', 'NEW_COURSE']) target: 'EXISTING_COURSE' | 'NEW_COURSE';
  @IsOptionalId() courseId?: string;
  @IsOptionalId() unitId?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.TITLE) newUnitTitle?: string;
  @IsOptional() @ValidateNested() @Type(() => NewCourseDto) newCourse?: NewCourseDto;
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
  @IsOptional() @IsBoolean() includeTranscript?: boolean;
  @IsOptional() @IsBoolean() includeSummary?: boolean;
}

/** A form field ("true"/"false") or a JSON boolean. */
const formBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

class CreateExamDto {
  /** The teacher saw that the transcript is incomplete and chose to go on. */
  @IsOptional() @Transform(formBool) @IsBoolean() acknowledgePartial?: boolean;
  /** Write from the class transcript (default: yes). Uploaded files, if any, come as `files`. */
  @IsOptional() @Transform(formBool) @IsBoolean() transcript?: boolean;
  @IsOptional() @IsString() @MaxLength(LIMITS.TITLE) title?: string;
}

class LinkExamDto {
  @IsId() examLessonId: string;
}

/**
 * "حوّل حصتك إلى محتوى": a finished Live class into course content. Course
 * authoring rights (`course.write`) — the same as building a course by hand —
 * plus the class itself being theirs to manage (LiveService's scope). Students
 * and guests never reach it.
 */
@ApiTags('live-content')
@ApiBearerAuth()
@UseGuards(AcademyMembershipGuard, PermissionGuard)
@RequirePermission('course.write')
@Controller('teacher/live')
export class LiveContentController {
  constructor(private readonly content: LiveContentService) {}

  private scope(user: JwtPayload, ctx: AcademyContext): ContentScope {
    const manageAll = ctx.role === 'OWNER';
    return {
      course: { academyId: ctx.academyId, authorTenantId: user.tenantId, manageAll },
      live: { academyId: ctx.academyId, userId: ctx.userId, manageAll, role: ctx.role },
      imports: { academyId: ctx.academyId, authorTenantId: user.tenantId, manageAll, userId: user.sub },
    };
  }

  @Get(':id/content')
  @ApiOperation({ summary: '[academy] What this class has become (lessons, exam) and can still become' })
  status(@CurrentUser() u: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.content.status(this.scope(u, ctx), id);
  }

  @Post(':id/content/lesson')
  @HttpCode(200)
  @ApiOperation({ summary: '[academy] The class recording as a course lesson (same video, no re-upload)' })
  publish(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: PublishLessonDto,
  ) {
    return this.content.publishLesson(this.scope(u, ctx), id, dto);
  }

  @Post(':id/content/exam')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({
    summary:
      '[academy] Start an Exam Studio session from the class transcript, uploaded material (PDF / PNG / JPEG / WebP), or both (nothing generated yet)',
  })
  @UseInterceptors(examUploadInterceptor())
  exam(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: CreateExamDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.content.createExam(this.scope(u, ctx), id, { ...dto, files: files ?? [] });
  }

  @Get(':id/content/exam-candidates')
  @ApiOperation({ summary: '[academy] Existing exams that can follow this class lesson' })
  candidates(@CurrentUser() u: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.content.examCandidates(this.scope(u, ctx), id);
  }

  @Post(':id/content/link-exam')
  @HttpCode(200)
  @ApiOperation({ summary: '[academy] Put an existing exam right after this class lesson (moved, not copied)' })
  link(
    @CurrentUser() u: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: LinkExamDto,
  ) {
    return this.content.linkExam(this.scope(u, ctx), id, dto.examLessonId);
  }
}

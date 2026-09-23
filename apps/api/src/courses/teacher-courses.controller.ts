import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { validateImageDataUrl } from '../common/image.util';
import { LIMITS } from '../common/validation';
import { CoursesService, CourseScope } from './courses.service';
import {
  CreateCourseDto,
  CreateLessonDto,
  ImportYoutubeDto,
  ReorderDto,
  SetBundleItemsDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpsertUnitDto,
} from './dto/course.dto';

class SetThumbnailDto {
  @IsString() @MaxLength(LIMITS.IMAGE_DATA_URL) dataUrl: string;
}

const INTRO_VIDEO_MIME = /^video\/mp4$/;
// Kept in step with KIND_MAX_VIDEO_BYTES.COURSE_INTRO in AcademyMediaService,
// which produces the message the teacher actually reads.
const INTRO_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Academy content-management API. Academy-aware: the active academy is resolved
 * (X-Academy-Id / subdomain / the owner's JWT tenant) and the caller must hold
 * `course.write` in it — so the OWNER *and* any TEACHER staff member can manage
 * content, each scoped to that academy. Owner behaviour is unchanged.
 */
@ApiTags('courses')
@ApiBearerAuth()
@UseGuards(AcademyMembershipGuard, PermissionGuard)
@RequirePermission('course.write')
@Controller('teacher')
export class TeacherCoursesController {
  constructor(
    private readonly courses: CoursesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Organisation from the validated context, authorship from the JWT — the
   * body never decides either. OWNER (incl. platform admin) manages every
   * course offered here; a TEACHER member only their own.
   */
  private scope(user: JwtPayload, ctx: AcademyContext): CourseScope {
    return {
      academyId: ctx.academyId,
      authorTenantId: user.tenantId,
      manageAll: ctx.role === 'OWNER',
    };
  }

  // ── Courses ──────────────────────────────────────────────────────────────

  @Get('courses')
  @ApiOperation({ summary: '[teacher] List my courses' })
  list(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    return this.courses.listMine(this.scope(user, ctx));
  }

  @Get('courses/:id')
  @ApiOperation({ summary: '[teacher] Course with full curriculum tree' })
  get(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.courses.getMine(this.scope(user, ctx), id);
  }

  @Post('courses')
  @ApiOperation({ summary: '[teacher] Create course (starts as DRAFT)' })
  async create(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Body() dto: CreateCourseDto,
  ) {
    const course = await this.courses.create(this.scope(user, ctx), dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'course.create',
      entity: 'Course',
      entityId: course.id,
      meta: { title: course.title },
    });
    return course;
  }

  @Patch('courses/:id')
  @ApiOperation({ summary: '[teacher] Update course (incl. publish/archive via status)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    const course = await this.courses.update(this.scope(user, ctx), id, dto);
    await this.audit.log({
      actorUserId: user.sub,
      action: dto.status ? `course.status.${dto.status.toLowerCase()}` : 'course.update',
      entity: 'Course',
      entityId: id,
    });
    return course;
  }

  @Delete('courses/:id')
  @ApiOperation({ summary: '[teacher] Delete course (archives instead if it has enrollments)' })
  async remove(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    const result = await this.courses.remove(this.scope(user, ctx), id);
    await this.audit.log({
      actorUserId: user.sub,
      action: result.deleted ? 'course.delete' : 'course.archive',
      entity: 'Course',
      entityId: id,
    });
    return result;
  }

  @Patch('courses/:id/thumbnail')
  @ApiOperation({ summary: '[teacher] Set course thumbnail (client-resized base64 image)' })
  async setThumbnail(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SetThumbnailDto,
  ) {
    validateImageDataUrl(dto.dataUrl, 600 * 1024); // ~600 KB after decode
    return this.courses.update(this.scope(user, ctx), id, { thumbnailUrl: dto.dataUrl });
  }

  @Post('courses/:id/intro-video')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: '[teacher] Upload the course intro clip (multipart: file, MP4)' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: INTRO_VIDEO_MAX_BYTES },
      fileFilter: (_req, file, cb) =>
        INTRO_VIDEO_MIME.test(file.mimetype)
          ? cb(null, true)
          : cb(new BadRequestException('Only MP4 video is accepted'), false),
    }),
  )
  async setIntroVideo(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('file is required');
    const result = await this.courses.setIntroVideo(this.scope(user, ctx), id, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
    await this.audit.log({
      actorUserId: user.sub,
      action: 'course.intro_video.set',
      entity: 'Course',
      entityId: id,
      meta: { bytes: file.size },
    });
    return result;
  }

  @Delete('courses/:id/intro-video')
  @ApiOperation({ summary: '[teacher] Remove the course intro clip' })
  async removeIntroVideo(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    const result = await this.courses.removeIntroVideo(this.scope(user, ctx), id);
    await this.audit.log({
      actorUserId: user.sub,
      action: 'course.intro_video.remove',
      entity: 'Course',
      entityId: id,
    });
    return result;
  }

  @Patch('courses/:id/bundle')
  @ApiOperation({ summary: '[teacher] Set the child courses of a BUNDLE course' })
  setBundle(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SetBundleItemsDto,
  ) {
    return this.courses.setBundleItems(this.scope(user, ctx), id, dto);
  }

  // ── Units ────────────────────────────────────────────────────────────────

  @Post('courses/:courseId/units')
  @ApiOperation({ summary: '[teacher] Add unit' })
  createUnit(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: UpsertUnitDto,
  ) {
    return this.courses.createUnit(this.scope(user, ctx), courseId, dto);
  }

  @Patch('units/:id')
  @ApiOperation({ summary: '[teacher] Rename unit' })
  updateUnit(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpsertUnitDto,
  ) {
    return this.courses.updateUnit(this.scope(user, ctx), id, dto);
  }

  @Delete('units/:id')
  @ApiOperation({ summary: '[teacher] Delete unit (cascades to its lessons)' })
  removeUnit(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.courses.removeUnit(this.scope(user, ctx), id);
  }

  @Patch('courses/:courseId/units/reorder')
  @ApiOperation({ summary: '[teacher] Reorder units (drag & drop)' })
  reorderUnits(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderUnits(this.scope(user, ctx), courseId, dto);
  }

  // ── Lessons ──────────────────────────────────────────────────────────────

  @Post('units/:unitId/lessons')
  @ApiOperation({ summary: '[teacher] Add lesson to a section (drip, preview, caps, video asset)' })
  createLesson(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('unitId') unitId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.courses.createLesson(this.scope(user, ctx), unitId, dto);
  }

  @Post('courses/:courseId/lessons')
  @ApiOperation({ summary: '[teacher] Add a lesson straight to the course, no section required' })
  addLessonDirect(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.courses.addLessonDirect(this.scope(user, ctx), courseId, dto);
  }

  @Post('courses/:courseId/lessons/import-youtube')
  @ApiOperation({
    summary: '[teacher] Bulk-create lessons from YouTube links (metadata + protected video)',
  })
  importYoutube(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: ImportYoutubeDto,
  ) {
    return this.courses.importYoutube(this.scope(user, ctx), courseId, dto);
  }

  @Patch('lessons/:id')
  @ApiOperation({ summary: '[teacher] Update lesson settings' })
  updateLesson(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.courses.updateLesson(this.scope(user, ctx), id, dto);
  }

  @Delete('lessons/:id')
  @ApiOperation({ summary: '[teacher] Delete lesson' })
  removeLesson(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.courses.removeLesson(this.scope(user, ctx), id);
  }

  @Delete('lessons/:id/video')
  @ApiOperation({ summary: "[teacher] Remove a lesson's video and clean up its storage" })
  removeLessonVideo(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
  ) {
    return this.courses.removeLessonVideo(this.scope(user, ctx), id);
  }

  @Patch('units/:unitId/lessons/reorder')
  @ApiOperation({ summary: '[teacher] Reorder lessons within a unit' })
  reorderLessons(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('unitId') unitId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderLessons(this.scope(user, ctx), unitId, dto);
  }
}

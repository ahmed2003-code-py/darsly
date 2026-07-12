import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { validateImageDataUrl } from '../common/image.util';
import { CoursesService } from './courses.service';
import {
  CreateCourseDto,
  CreateLessonDto,
  ReorderDto,
  SetBundleItemsDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpsertUnitDto,
} from './dto/course.dto';

class SetThumbnailDto {
  @IsString() dataUrl: string;
}

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

  // ── Courses ──────────────────────────────────────────────────────────────

  @Get('courses')
  @ApiOperation({ summary: '[teacher] List my courses' })
  list(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext) {
    return this.courses.listMine(ctx.academyId);
  }

  @Get('courses/:id')
  @ApiOperation({ summary: '[teacher] Course with full curriculum tree' })
  get(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.courses.getMine(ctx.academyId, id);
  }

  @Post('courses')
  @ApiOperation({ summary: '[teacher] Create course (starts as DRAFT)' })
  async create(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateCourseDto) {
    const course = await this.courses.create(ctx.academyId, dto);
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
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    const course = await this.courses.update(ctx.academyId, id, dto);
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
  async remove(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    const result = await this.courses.remove(ctx.academyId, id);
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
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SetThumbnailDto,
  ) {
    validateImageDataUrl(dto.dataUrl, 600 * 1024); // ~600 KB after decode
    return this.courses.update(ctx.academyId, id, { thumbnailUrl: dto.dataUrl });
  }

  @Patch('courses/:id/bundle')
  @ApiOperation({ summary: '[teacher] Set the child courses of a BUNDLE course' })
  setBundle(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SetBundleItemsDto,
  ) {
    return this.courses.setBundleItems(ctx.academyId, id, dto);
  }

  // ── Units ────────────────────────────────────────────────────────────────

  @Post('courses/:courseId/units')
  @ApiOperation({ summary: '[teacher] Add unit' })
  createUnit(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: UpsertUnitDto,
  ) {
    return this.courses.createUnit(ctx.academyId, courseId, dto);
  }

  @Patch('units/:id')
  @ApiOperation({ summary: '[teacher] Rename unit' })
  updateUnit(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: UpsertUnitDto) {
    return this.courses.updateUnit(ctx.academyId, id, dto);
  }

  @Delete('units/:id')
  @ApiOperation({ summary: '[teacher] Delete unit (cascades to its lessons)' })
  removeUnit(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.courses.removeUnit(ctx.academyId, id);
  }

  @Patch('courses/:courseId/units/reorder')
  @ApiOperation({ summary: '[teacher] Reorder units (drag & drop)' })
  reorderUnits(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('courseId') courseId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderUnits(ctx.academyId, courseId, dto);
  }

  // ── Lessons ──────────────────────────────────────────────────────────────

  @Post('units/:unitId/lessons')
  @ApiOperation({ summary: '[teacher] Add lesson (drip, preview, caps, video asset)' })
  createLesson(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('unitId') unitId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.courses.createLesson(ctx.academyId, unitId, dto);
  }

  @Patch('lessons/:id')
  @ApiOperation({ summary: '[teacher] Update lesson settings' })
  updateLesson(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.courses.updateLesson(ctx.academyId, id, dto);
  }

  @Delete('lessons/:id')
  @ApiOperation({ summary: '[teacher] Delete lesson' })
  removeLesson(@CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.courses.removeLesson(ctx.academyId, id);
  }

  @Patch('units/:unitId/lessons/reorder')
  @ApiOperation({ summary: '[teacher] Reorder lessons within a unit' })
  reorderLessons(
    @CurrentUser() user: JwtPayload, @CurrentAcademy() ctx: AcademyContext,
    @Param('unitId') unitId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderLessons(ctx.academyId, unitId, dto);
  }
}

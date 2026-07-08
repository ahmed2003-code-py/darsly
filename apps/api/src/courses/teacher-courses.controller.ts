import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
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

/**
 * Teacher content-management API. Every route requires the TEACHER role and
 * operates strictly inside the caller's tenant (tenantId from the JWT).
 */
@ApiTags('courses')
@ApiBearerAuth()
@Roles(Role.TEACHER)
@Controller('teacher')
export class TeacherCoursesController {
  constructor(
    private readonly courses: CoursesService,
    private readonly audit: AuditService,
  ) {}

  // ── Courses ──────────────────────────────────────────────────────────────

  @Get('courses')
  @ApiOperation({ summary: '[teacher] List my courses' })
  list(@CurrentUser() user: JwtPayload) {
    return this.courses.listMine(user.tenantId!);
  }

  @Get('courses/:id')
  @ApiOperation({ summary: '[teacher] Course with full curriculum tree' })
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.getMine(user.tenantId!, id);
  }

  @Post('courses')
  @ApiOperation({ summary: '[teacher] Create course (starts as DRAFT)' })
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCourseDto) {
    const course = await this.courses.create(user.tenantId!, dto);
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
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    const course = await this.courses.update(user.tenantId!, id, dto);
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
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const result = await this.courses.remove(user.tenantId!, id);
    await this.audit.log({
      actorUserId: user.sub,
      action: result.deleted ? 'course.delete' : 'course.archive',
      entity: 'Course',
      entityId: id,
    });
    return result;
  }

  @Patch('courses/:id/bundle')
  @ApiOperation({ summary: '[teacher] Set the child courses of a BUNDLE course' })
  setBundle(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetBundleItemsDto,
  ) {
    return this.courses.setBundleItems(user.tenantId!, id, dto);
  }

  // ── Units ────────────────────────────────────────────────────────────────

  @Post('courses/:courseId/units')
  @ApiOperation({ summary: '[teacher] Add unit' })
  createUnit(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: UpsertUnitDto,
  ) {
    return this.courses.createUnit(user.tenantId!, courseId, dto);
  }

  @Patch('units/:id')
  @ApiOperation({ summary: '[teacher] Rename unit' })
  updateUnit(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpsertUnitDto) {
    return this.courses.updateUnit(user.tenantId!, id, dto);
  }

  @Delete('units/:id')
  @ApiOperation({ summary: '[teacher] Delete unit (cascades to its lessons)' })
  removeUnit(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.removeUnit(user.tenantId!, id);
  }

  @Patch('courses/:courseId/units/reorder')
  @ApiOperation({ summary: '[teacher] Reorder units (drag & drop)' })
  reorderUnits(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderUnits(user.tenantId!, courseId, dto);
  }

  // ── Lessons ──────────────────────────────────────────────────────────────

  @Post('units/:unitId/lessons')
  @ApiOperation({ summary: '[teacher] Add lesson (drip, preview, caps, video asset)' })
  createLesson(
    @CurrentUser() user: JwtPayload,
    @Param('unitId') unitId: string,
    @Body() dto: CreateLessonDto,
  ) {
    return this.courses.createLesson(user.tenantId!, unitId, dto);
  }

  @Patch('lessons/:id')
  @ApiOperation({ summary: '[teacher] Update lesson settings' })
  updateLesson(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.courses.updateLesson(user.tenantId!, id, dto);
  }

  @Delete('lessons/:id')
  @ApiOperation({ summary: '[teacher] Delete lesson' })
  removeLesson(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.removeLesson(user.tenantId!, id);
  }

  @Patch('units/:unitId/lessons/reorder')
  @ApiOperation({ summary: '[teacher] Reorder lessons within a unit' })
  reorderLessons(
    @CurrentUser() user: JwtPayload,
    @Param('unitId') unitId: string,
    @Body() dto: ReorderDto,
  ) {
    return this.courses.reorderLessons(user.tenantId!, unitId, dto);
  }
}

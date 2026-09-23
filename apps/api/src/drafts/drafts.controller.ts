import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContentDraftKind } from '@prisma/client';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy, RequirePermission } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { PermissionGuard } from '../academy/guards/permission.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SaveDraftBodyDto } from './dto/drafts.dto';
import { DraftScope, DraftsService } from './drafts.service';

/**
 * Unfinished work, for the teacher who owns it.
 *
 * Authorized exactly like courses: the academy comes from the membership
 * guard, `course.write` is required in it, and every query is scoped by that
 * academy and by the caller's own tenant unless they own the place. A draft is
 * somebody's unpublished lesson; it is no more public than the lesson.
 */
@ApiTags('drafts')
@ApiBearerAuth()
@UseGuards(AcademyMembershipGuard, PermissionGuard)
@RequirePermission('course.write')
@Controller('teacher/drafts')
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  private scope(user: JwtPayload, ctx: AcademyContext): DraftScope {
    return {
      academyId: ctx.academyId,
      authorTenantId: user.tenantId,
      manageAll: ctx.role === 'OWNER',
      userId: user.sub,
    };
  }

  @Get()
  @ApiOperation({ summary: '[teacher] Everything I started and have not finished' })
  list(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Query('courseId') courseId?: string,
  ) {
    return this.drafts.list(this.scope(user, ctx), courseId || undefined);
  }

  @Put()
  @ApiOperation({ summary: '[teacher] Save what is in a form right now' })
  async save(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Body() dto: SaveDraftBodyDto,
  ) {
    return this.drafts.save(this.scope(user, ctx), {
      kind: dto.kind as unknown as ContentDraftKind,
      scopeKey: dto.scopeKey,
      courseId: dto.courseId ?? null,
      lessonId: dto.lessonId ?? null,
      label: dto.label,
      step: dto.step,
      data: dto.data,
    });
  }

  /**
   * One draft by the key the form knows it by.
   *
   * Declared after the collection routes so `/teacher/drafts` is not swallowed
   * by it — Nest matches in declaration order.
   */
  @Get(':scopeKey')
  @ApiOperation({ summary: '[teacher] The draft for one form, or null' })
  find(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('scopeKey') scopeKey: string,
  ) {
    return this.drafts.find(this.scope(user, ctx), scopeKey);
  }

  @Delete(':scopeKey')
  @ApiOperation({ summary: '[teacher] Throw a draft away, or clear a saved one' })
  discard(
    @CurrentUser() user: JwtPayload,
    @CurrentAcademy() ctx: AcademyContext,
    @Param('scopeKey') scopeKey: string,
  ) {
    return this.drafts.discard(this.scope(user, ctx), scopeKey);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtPayload } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyService } from '../academy/academy.service';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CorrectDto,
  CreateExamDto,
  CreateMakeupDto,
  ExamsQuery,
  GradeSettingsDto,
  SaveResultsDto,
  UpdateExamDto,
  VoidDto,
} from './dto';
import { GradesReadService } from './grades-read.service';
import { PaperExamsService } from './paper-exams.service';

/**
 * Paper exams and grades (Center Operations C6).
 *
 * Every route but the two access probes sits behind @AcademyStaffFeature: an
 * ACTIVE membership in the academy named by X-Academy-Id, the capability, and
 * the `paperExams` flag. On top of that the service enforces GROUP reach: the
 * owner reaches every group, anyone else only the groups they are currently
 * assigned to (a foreign group is a 403, a foreign academy's exam a 404).
 * Reading needs grades.view; creating, draft grades and publishing
 * grades.manage; correcting a published grade and voiding grades.correct; the
 * settings academy.manage.
 */
@ApiTags('paper-exams')
@ApiBearerAuth()
@Controller('paper-exams')
export class PaperExamsController {
  constructor(
    private readonly exams: PaperExamsService,
    private readonly read: GradesReadService,
    private readonly flags: FeatureFlagsService,
    private readonly academy: AcademyService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Are paper exams on here, and what may I do' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'paperExams');
    const can = (c: Parameters<AcademyContext['can']>[0]) => enabled && ctx.can(c);
    return {
      enabled,
      canView: can('grades.view'),
      canManage: can('grades.manage') && can('grades.view'),
      canCorrect: can('grades.correct') && can('grades.view'),
      canSettings: can('academy.manage'),
      allGroups: enabled && (ctx.role === 'OWNER' || ctx.isPlatformAdmin),
    };
  }

  /** Academies where I may see paper exams — for the menu; never a 403. */
  @Get('my-access')
  @ApiOperation({ summary: 'Where paper exams are on for me' })
  async myAccess(@CurrentUser() user: JwtPayload) {
    const rows = await this.prisma.academyMembership.findMany({
      where: {
        userId: user.sub,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
      },
      select: { academyId: true, academy: { select: { id: true, name: true, slug: true } } },
    });
    const academies: { id: string; name: string; slug: string }[] = [];
    for (const r of rows) {
      if (!(await this.flags.isEnabled(r.academyId, 'paperExams'))) continue;
      const ctx = await this.academy.buildContext(user.sub, r.academyId, user.role);
      if (ctx?.can('grades.view')) academies.push(r.academy);
    }
    return { enabled: academies.length > 0, academies };
  }

  @Get('groups')
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: '[academy] Groups I reach' })
  groups(@CurrentAcademy() ctx: AcademyContext) {
    return this.exams.groups(ctx);
  }

  @Get()
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: '[academy] Paper exams of the groups I reach' })
  list(@CurrentAcademy() ctx: AcademyContext, @Query() q: ExamsQuery) {
    return this.exams.list(ctx, q);
  }

  @Post()
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Create a paper exam (idempotent by request key)' })
  create(@CurrentAcademy() ctx: AcademyContext, @Body() dto: CreateExamDto) {
    return this.exams.create(ctx, dto);
  }

  @Get('settings')
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: '[academy] Low-grade threshold and guardian visibility' })
  settings(@CurrentAcademy() ctx: AcademyContext) {
    return this.exams.getSettings(ctx.academyId);
  }

  @Patch('settings')
  @AcademyStaffFeature('academy.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Change the threshold or guardian visibility (owner)' })
  updateSettings(@CurrentAcademy() ctx: AcademyContext, @Body() dto: GradeSettingsDto) {
    return this.exams.updateSettings(ctx, dto);
  }

  /**
   * Student 360 by the learner's profile (a teacher holds no register access):
   * the same reach-filtered history, so a teacher sees only their groups' grades.
   */
  @Get('by-student/:studentId')
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: "[academy] A learner's published grades, by their profile" })
  async byStudent(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    const s = await this.prisma.academyStudent.findFirst({
      where: { studentId, academyId: ctx.academyId },
      select: { id: true },
    });
    if (!s) return { items: [] };
    return { items: await this.read.history(ctx.academyId, s.id, await this.read.reach(ctx)) };
  }

  @Get(':id')
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: '[academy] One exam: its sheet and statistics' })
  sheet(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.exams.sheet(ctx, id);
  }

  @Patch(':id')
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Edit an exam (marks and date only while a draft)' })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateExamDto,
  ) {
    return this.exams.update(ctx, id, dto);
  }

  @Delete(':id')
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Delete an EMPTY draft (anything else is voided)' })
  remove(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.exams.remove(ctx, id);
  }

  @Put(':id/results')
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Save draft grades (request key + per-row versions)' })
  save(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: SaveResultsDto,
  ) {
    return this.exams.saveResults(ctx, id, dto);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Publish (atomic; every expected learner needs a result)' })
  publish(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.exams.publish(ctx, id);
  }

  @Post(':id/makeups')
  @AcademyStaffFeature('grades.manage', 'paperExams')
  @ApiOperation({ summary: '[academy] Create a makeup sitting of a published exam' })
  makeup(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: CreateMakeupDto,
  ) {
    return this.exams.createMakeup(ctx, id, dto);
  }

  @Post(':id/results/:studentId/correct')
  @HttpCode(200)
  @AcademyStaffFeature('grades.correct', 'paperExams')
  @ApiOperation({ summary: '[academy] Correct a published grade, with a reason' })
  correct(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
    @Body() dto: CorrectDto,
  ) {
    return this.exams.correct(ctx, id, studentId, dto);
  }

  @Post(':id/void')
  @HttpCode(200)
  @AcademyStaffFeature('grades.correct', 'paperExams')
  @ApiOperation({ summary: '[academy] Void an exam, with a reason (kept, excluded)' })
  voidExam(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: VoidDto) {
    return this.exams.voidExam(ctx, id, dto.reason);
  }

  @Get(':id/export')
  @AcademyStaffFeature('grades.view', 'paperExams')
  @ApiOperation({ summary: "[academy] An exam's results as CSV" })
  async export(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { filename, csv } = await this.exams.exportCsv(ctx, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}

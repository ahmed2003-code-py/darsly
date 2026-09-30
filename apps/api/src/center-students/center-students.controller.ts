import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CenterStudentsService } from './center-students.service';
import {
  AddToGroupDto,
  ImportPreviewDto,
  ListStudentsQuery,
  RegisterStudentDto,
  UpdateStudentDto,
} from './dto';
import { StudentImportService } from './student-import.service';

/**
 * The academy's student register (Center Operations C1).
 *
 * Every route but `access` sits behind @AcademyStaffFeature: an ACTIVE
 * membership in the academy named by X-Academy-Id, the capability, and the
 * `studentRegistry` flag — enforced here, whatever the menu shows. Reading
 * the register needs `student.directory`; changing it needs `student.register`.
 */
@ApiTags('center-students')
@ApiBearerAuth()
@Controller('center-students')
export class CenterStudentsController {
  constructor(
    private readonly students: CenterStudentsService,
    private readonly imports: StudentImportService,
    private readonly flags: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  /** What this member may do with the register here — for the menu; never a 403. */
  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Is the register on here, and may I read / change it' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'studentRegistry');
    return {
      enabled,
      canView: enabled && ctx.can('student.directory'),
      canRegister: enabled && ctx.can('student.register'),
    };
  }

  @Get()
  @AcademyStaffFeature('student.directory', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Search the register (code, phone, name)' })
  list(@CurrentAcademy() ctx: AcademyContext, @Query() query: ListStudentsQuery) {
    return this.students.list(ctx, query);
  }

  @Get('export')
  @AcademyStaffFeature('student.directory', 'studentRegistry')
  @ApiOperation({ summary: '[academy] The register as CSV' })
  async export(
    @CurrentAcademy() ctx: AcademyContext,
    @Query() query: ListStudentsQuery,
    @Res() res: Response,
  ) {
    const { csv } = await this.students.exportCsv(ctx, query.status ?? 'ALL');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }

  /** The groups the desk may put a learner into (reception holds no group.manage). */
  @Get('groups')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Active groups, for enrolling a register student' })
  async groups(@CurrentAcademy() ctx: AcademyContext) {
    const rows = await this.prisma.group.findMany({
      where: { academyId: ctx.academyId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        _count: { select: { members: { where: { deletedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((g) => ({ id: g.id, name: g.name, members: g._count.members }));
  }

  @Post('import/preview')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Validate a spreadsheet; writes nothing to the register' })
  preview(@CurrentAcademy() ctx: AcademyContext, @Body() dto: ImportPreviewDto) {
    return this.imports.preview(ctx, dto);
  }

  @Get('import/:importId')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] An import batch and its outcome' })
  importStatus(@CurrentAcademy() ctx: AcademyContext, @Param('importId') importId: string) {
    return this.imports.get(ctx, importId);
  }

  @Post('import/:importId/commit')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Write a previewed import (safe to repeat)' })
  commit(@CurrentAcademy() ctx: AcademyContext, @Param('importId') importId: string) {
    return this.imports.commit(ctx, importId);
  }

  /** Student 360: this academy's record of a learner, or null. */
  @Get('by-student/:studentId')
  @AcademyStaffFeature('student.directory', 'studentRegistry')
  @ApiOperation({ summary: "[academy] The register record behind a learner's profile" })
  async byStudent(@CurrentAcademy() ctx: AcademyContext, @Param('studentId') studentId: string) {
    return { record: await this.students.forStudent(ctx, studentId) };
  }

  @Post()
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Register a learner (no account needed; safe to repeat)' })
  register(@CurrentAcademy() ctx: AcademyContext, @Body() dto: RegisterStudentDto) {
    return this.students.register(ctx, dto);
  }

  @Get(':id')
  @AcademyStaffFeature('student.directory', 'studentRegistry')
  @ApiOperation({ summary: '[academy] One register record' })
  get(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.students.get(ctx, id);
  }

  @Patch(':id')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Edit what the academy records about a learner' })
  update(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.students.update(ctx, id, dto);
  }

  @Post(':id/withdraw')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] The learner left (nothing is deleted)' })
  withdraw(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.students.withdraw(ctx, id);
  }

  @Post(':id/reactivate')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] The learner is back' })
  reactivate(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.students.reactivate(ctx, id);
  }

  @Post(':id/groups')
  @AcademyStaffFeature('student.register', 'studentRegistry')
  @ApiOperation({ summary: '[academy] Put a register learner into a group (add only)' })
  addToGroup(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: AddToGroupDto,
  ) {
    return this.students.addToGroup(ctx, id, dto);
  }
}

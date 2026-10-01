import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AssignDto,
  CasesQuery,
  CloseDto,
  LogContactDto,
  OpenCaseDto,
  PageQuery,
  SettingsDto,
  SignalsQuery,
  TimelineQuery,
} from './dto';
import { FollowUpService } from './follow-up.service';
import { FollowUpSettingsService } from './settings.service';
import { FollowUpSignalsService } from './signals.service';
import { TimelineService } from './timeline.service';

/**
 * Student follow-up (Center Operations C5).
 *
 * Every route but `access` sits behind @AcademyStaffFeature: an ACTIVE
 * membership in the academy named by X-Academy-Id, the capability, and the
 * `studentFollowUp` flag. Reading — signals, cases, contacts with their
 * notes, the timeline — needs followup.view; opening, assigning and closing
 * cases and logging contacts followup.manage; the settings academy.manage.
 * Teachers hold neither by default.
 */
@ApiTags('follow-up')
@ApiBearerAuth()
@Controller('follow-up')
export class FollowUpController {
  constructor(
    private readonly followUp: FollowUpService,
    private readonly signals: FollowUpSignalsService,
    private readonly timeline: TimelineService,
    private readonly settings: FollowUpSettingsService,
    private readonly flags: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Is follow-up on here, and what may I do' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const enabled = await this.flags.isEnabled(ctx.academyId, 'studentFollowUp');
    const can = (c: Parameters<AcademyContext['can']>[0]) => enabled && ctx.can(c);
    return {
      enabled,
      canView: can('followup.view'),
      canManage: can('followup.manage') && can('followup.view'),
      canSettings: can('academy.manage'),
      canGuardians: can('guardian.manage'),
      seesFees: can('fees.view') && (await this.flags.isEnabled(ctx.academyId, 'centerFees')),
    };
  }

  // ── Today ──

  @Get('signals')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: "[academy] Today's follow-up signals (derived, paged)" })
  signalsToday(@CurrentAcademy() ctx: AcademyContext, @Query() q: SignalsQuery) {
    return this.signals.today(ctx, {
      reason: q.reason,
      notContacted: !!q.notContacted,
      page: q.page,
    });
  }

  @Get('contacts/today')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Families contacted today' })
  contactsToday(@CurrentAcademy() ctx: AcademyContext, @Query() q: PageQuery) {
    return this.followUp.contactsToday(ctx, q.page);
  }

  // ── Cases ──

  @Get('cases')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Follow-up cases' })
  cases(@CurrentAcademy() ctx: AcademyContext, @Query() q: CasesQuery) {
    return this.followUp.cases(ctx, { status: q.status, mine: !!q.mine, page: q.page });
  }

  @Post('cases')
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Open a case (from a signal, or by hand) — idempotent' })
  open(@CurrentAcademy() ctx: AcademyContext, @Body() dto: OpenCaseDto) {
    return this.followUp.open(ctx, dto);
  }

  @Post('cases/:id/assign')
  @HttpCode(200)
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Assign an open case' })
  assign(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.followUp.assign(ctx, id, dto);
  }

  @Post('cases/:id/resolve')
  @HttpCode(200)
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Resolve an open case, with how' })
  resolve(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: CloseDto) {
    return this.followUp.close(ctx, id, 'RESOLVED', dto.reason);
  }

  @Post('cases/:id/dismiss')
  @HttpCode(200)
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Dismiss an open case, with why' })
  dismiss(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: CloseDto) {
    return this.followUp.close(ctx, id, 'DISMISSED', dto.reason);
  }

  @Get('staff')
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Who a case can be assigned to' })
  async staff(@CurrentAcademy() ctx: AcademyContext) {
    const members = await this.prisma.academyMembership.findMany({
      where: {
        academyId: ctx.academyId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['OWNER', 'ASSISTANT', 'TEACHER'] },
      },
      select: { role: true, permissions: true, user: { select: { id: true, fullName: true } } },
    });
    return members
      .filter((m) => {
        const p = Array.isArray(m.permissions) ? (m.permissions as string[]) : [];
        return m.role === 'OWNER' || p.includes('followup.view') || p.includes('followup.manage');
      })
      .map((m) => ({ id: m.user.id, name: m.user.fullName }));
  }

  // ── One learner ──

  @Get('students/:id')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: "[academy] A learner's cases, contacts and reachable family" })
  student(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return this.followUp.student(ctx, id);
  }

  @Post('students/:id/contacts')
  @AcademyStaffFeature('followup.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Log a contact with the family (append-only, idempotent)' })
  logContact(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Body() dto: LogContactDto,
  ) {
    return this.followUp.logContact(ctx, id, dto);
  }

  @Get('students/:id/timeline')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: "[academy] A learner's timeline (composed; fees only with fees.view)" })
  timelineOf(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('id') id: string,
    @Query() q: TimelineQuery,
  ) {
    return this.timeline.forStudent(ctx, id, q.before);
  }

  // ── Settings ──

  @Get('settings')
  @AcademyStaffFeature('followup.view', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Signal thresholds and guardian fee visibility' })
  getSettings(@CurrentAcademy() ctx: AcademyContext) {
    return this.settings.get(ctx.academyId);
  }

  @Patch('settings')
  @AcademyStaffFeature('academy.manage', 'studentFollowUp')
  @ApiOperation({ summary: '[academy] Change thresholds or guardian fee visibility (owner)' })
  updateSettings(@CurrentAcademy() ctx: AcademyContext, @Body() dto: SettingsDto) {
    return this.settings.update(ctx, dto);
  }
}

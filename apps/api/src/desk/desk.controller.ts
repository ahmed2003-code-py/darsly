import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyMembershipGuard } from '../academy/guards/academy-membership.guard';
import { AcademyStaffFeature } from '../feature-flags/academy-staff-feature.decorator';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { DeskService } from './desk.service';
import { DeskCheckInDto, DeskIdentityDto, ReissueCardDto, RevokeCardDto } from './dto';

/**
 * The reception desk (Center Operations C3).
 *
 * Every route but `access` sits behind @AcademyStaffFeature: an ACTIVE
 * membership in the academy named by X-Academy-Id, the capability, and the
 * `receptionDesk` flag — whatever the menu shows. Identifying and checking
 * in needs `desk.checkin`; cards need `card.manage`.
 *
 * Card tokens travel only in POST bodies, never in a path or query string,
 * so they cannot land in access logs, browser history or a Referer header.
 */
@ApiTags('desk')
@ApiBearerAuth()
@Controller('desk')
export class DeskController {
  constructor(
    private readonly desk: DeskService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** What this member may do at the desk here — for the menu; never a 403. */
  @Get('access')
  @UseGuards(AcademyMembershipGuard)
  @ApiOperation({ summary: '[academy] Is the desk on here, and what may I do at it' })
  async access(@CurrentAcademy() ctx: AcademyContext) {
    const [enabled, registry, classes] = await Promise.all([
      this.flags.isEnabled(ctx.academyId, 'receptionDesk'),
      this.flags.isEnabled(ctx.academyId, 'studentRegistry'),
      this.flags.isEnabled(ctx.academyId, 'classOperations'),
    ]);
    return {
      enabled,
      canCheckIn: enabled && ctx.can('desk.checkin'),
      canManageCards: enabled && ctx.can('card.manage'),
      // The C1 search and registration the desk reuses, as C1 decides them.
      canSearch: enabled && registry && ctx.can('student.directory'),
      canRegister: enabled && registry && ctx.can('student.register'),
      classes,
    };
  }

  @Post('resolve')
  @HttpCode(200)
  @AcademyStaffFeature('desk.checkin', 'receptionDesk')
  @ApiOperation({ summary: '[academy] Who this is and their classes today (card, code or record)' })
  resolve(@CurrentAcademy() ctx: AcademyContext, @Body() dto: DeskIdentityDto) {
    return this.desk.resolve(ctx, dto);
  }

  @Post('check-in')
  @HttpCode(200)
  @AcademyStaffFeature('desk.checkin', 'receptionDesk')
  @ApiOperation({ summary: '[academy] Check a learner into a real class (safe to repeat)' })
  checkIn(@CurrentAcademy() ctx: AcademyContext, @Body() dto: DeskCheckInDto) {
    return this.desk.checkIn(ctx, dto);
  }

  @Get('cards/:academyStudentId')
  @AcademyStaffFeature('card.manage', 'receptionDesk')
  @ApiOperation({ summary: "[academy] A learner's card: the active one and recent history" })
  card(@CurrentAcademy() ctx: AcademyContext, @Param('academyStudentId') id: string) {
    return this.desk.cardState(ctx, id);
  }

  @Post('cards/:academyStudentId/issue')
  @AcademyStaffFeature('card.manage', 'receptionDesk')
  @ApiOperation({ summary: '[academy] Issue a first card (the token is returned once, to print)' })
  issue(@CurrentAcademy() ctx: AcademyContext, @Param('academyStudentId') id: string) {
    return this.desk.issue(ctx, id);
  }

  @Post('cards/:academyStudentId/reissue')
  @AcademyStaffFeature('card.manage', 'receptionDesk')
  @ApiOperation({ summary: '[academy] Replace the active card; the old one stops working at once' })
  reissue(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('academyStudentId') id: string,
    @Body() dto: ReissueCardDto,
  ) {
    return this.desk.reissue(ctx, id, dto);
  }

  @Post('cards/:academyStudentId/revoke')
  @HttpCode(200)
  @AcademyStaffFeature('card.manage', 'receptionDesk')
  @ApiOperation({ summary: '[academy] Cancel a card (safe to repeat)' })
  revoke(
    @CurrentAcademy() ctx: AcademyContext,
    @Param('academyStudentId') id: string,
    @Body() dto: RevokeCardDto,
  ) {
    return this.desk.revoke(ctx, id, dto);
  }
}

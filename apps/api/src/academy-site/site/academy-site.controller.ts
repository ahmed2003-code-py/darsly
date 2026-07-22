import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../../academy/academy-context';
import { AcademyStaff } from '../../academy/academy-staff.decorator';
import { AiFeatureEnabledGuard } from '../ai-feature.guard';
import { AcademySiteService } from './academy-site.service';
import { RollbackDto } from './dto/rollback.dto';

@ApiTags('academy-studio/site')
@UseGuards(AiFeatureEnabledGuard)
@Controller('academy/site')
export class AcademySiteController {
  constructor(private readonly site: AcademySiteService) {}

  @Get()
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Studio overview: status, draft, publish state, last job' })
  overview(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.overview(ctx.academyId);
  }

  @Post('publish')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Publish the draft (first time → moderation queue)' })
  publish(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.publish(ctx.academyId, ctx.userId);
  }

  @Post('unpublish')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Take the published page offline' })
  unpublish(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.unpublish(ctx.academyId, ctx.userId);
  }

  @Get('snapshots')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] List document version history' })
  snapshots(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.listSnapshots(ctx.academyId);
  }

  @Post('rollback')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Restore the draft from a snapshot' })
  rollback(@CurrentAcademy() ctx: AcademyContext, @Body() dto: RollbackDto) {
    return this.site.rollback(ctx.academyId, dto.snapshotId, ctx.userId);
  }
}

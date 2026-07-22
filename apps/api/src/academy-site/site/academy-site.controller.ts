import { Body, Controller, Get, Header, Post, Put, UseGuards } from '@nestjs/common';
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

  @Get('draft')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Load the current draft document (editor)' })
  getDraft(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.getDraft(ctx.academyId);
  }

  @Get('preview')
  @AcademyStaff('academy.manage')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: '[staff] Compiled HTML of the current draft (owner preview)' })
  preview(@CurrentAcademy() ctx: AcademyContext) {
    return this.site.previewHtml(ctx.academyId);
  }

  @Put('draft')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Save an edited draft document (editor)' })
  // Raw Site Document — validated with zod in the service, not class-validator.
  saveDraft(@CurrentAcademy() ctx: AcademyContext, @Body() body: unknown) {
    return this.site.saveEditedDraft(ctx.academyId, body, ctx.userId);
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

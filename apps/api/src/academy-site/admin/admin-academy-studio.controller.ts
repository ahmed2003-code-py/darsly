import { Body, Controller, Get, Header, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AiJobService } from '../jobs/ai-job.service';
import { AcademySiteService } from '../site/academy-site.service';
import { AdminAcademyStudioService } from './admin-academy-studio.service';
import { ModerateSiteDto, TakedownSiteDto } from './dto/moderate.dto';

@ApiTags('admin/academy-studio')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/academy-studio')
export class AdminAcademyStudioController {
  constructor(
    private readonly admin: AdminAcademyStudioService,
    private readonly site: AcademySiteService,
    private readonly jobs: AiJobService,
  ) {}

  @Get('moderation-queue')
  @ApiOperation({ summary: '[admin] Sites awaiting moderation' })
  queue() {
    return this.admin.moderationQueue();
  }

  @Get('sites/:academyId')
  @ApiOperation({ summary: '[admin] Inspect one academy site (incl. draft doc)' })
  async site_(@Param('academyId') academyId: string) {
    const site = await this.admin.getSite(academyId);
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }

  @Get('sites/:academyId/preview')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: '[admin] Compiled HTML preview of an academy site' })
  preview(@Param('academyId') academyId: string) {
    return this.site.previewHtml(academyId);
  }

  @Post('sites/:academyId/moderate')
  @ApiOperation({ summary: '[admin] Approve or reject a pending site' })
  moderate(
    @CurrentUser() user: JwtPayload,
    @Param('academyId') academyId: string,
    @Body() dto: ModerateSiteDto,
  ) {
    return this.site.moderate(academyId, dto.decision, dto.reason, user.sub);
  }

  @Post('sites/:academyId/takedown')
  @ApiOperation({ summary: '[admin] Take a live site offline' })
  takedown(
    @CurrentUser() user: JwtPayload,
    @Param('academyId') academyId: string,
    @Body() dto: TakedownSiteDto,
  ) {
    return this.site.takedown(academyId, dto.reason, user.sub);
  }

  @Get('ai/usage')
  @ApiOperation({ summary: '[admin] AI usage + spend dashboard' })
  usage() {
    return this.admin.usage();
  }

  @Post('ai/jobs/:id/rerun')
  @ApiOperation({ summary: '[admin] Re-queue a FAILED AI job' })
  rerun(@Param('id') id: string) {
    return this.jobs.rerunFailed(id);
  }
}

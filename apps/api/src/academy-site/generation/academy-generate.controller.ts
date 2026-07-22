import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcademyContext, CurrentAcademy } from '../../academy/academy-context';
import { AcademyStaff } from '../../academy/academy-staff.decorator';
import { AiFeatureEnabledGuard } from '../ai-feature.guard';
import { AiJobService } from '../jobs/ai-job.service';
import { GenerateSiteDto } from './dto/generate.dto';

function jobView(job: {
  id: string;
  status: string;
  stage: string | null;
  attempts: number;
  error: string | null;
  costCents: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    attempts: job.attempts,
    error: job.error,
    costCents: job.costCents,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

@ApiTags('academy-studio/generate')
@UseGuards(AiFeatureEnabledGuard)
@Controller('academy/site')
export class AcademyGenerateController {
  constructor(private readonly jobs: AiJobService) {}

  @Post('generate')
  @AcademyStaff('academy.manage')
  // Expensive AI work — tight per-user limit on top of the one-active-job guard.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: '[staff] Queue AI site generation for this academy' })
  async generate(@CurrentAcademy() ctx: AcademyContext, @Body() dto: GenerateSiteDto) {
    const job = await this.jobs.enqueue(ctx.academyId, 'SITE_GENERATE', { vibe: dto.vibe ?? null });
    return jobView(job);
  }

  @Get('jobs/:id')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Poll an AI job status' })
  async status(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    const job = await this.jobs.getForAcademy(ctx.academyId, id);
    if (!job) throw new NotFoundException('Job not found');
    return jobView(job);
  }

  @Post('jobs/:id/cancel')
  @AcademyStaff('academy.manage')
  @ApiOperation({ summary: '[staff] Cancel a queued AI job' })
  async cancel(@CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    return jobView(await this.jobs.cancel(ctx.academyId, id));
  }
}

import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteConfig } from './academy-site.config';
import { AiClient } from './ai/ai.client';
import { AI_JOB_HANDLERS } from './jobs/ai-job.handler';
import { AiJobService } from './jobs/ai-job.service';
import { AiJobWorker } from './jobs/ai-job.worker';
import { AcademyMediaController } from './media/academy-media.controller';
import { AcademyMediaProcessor } from './media/academy-media.processor';
import { AcademyMediaService } from './media/academy-media.service';
import { MediaMaintenanceWorker } from './media/media-maintenance.worker';

/**
 * Academy Studio (AI site) module. Slice 2 wires the job infrastructure only;
 * later slices add the generation handler (AI_JOB_HANDLERS), media pipeline,
 * facts/editor APIs, renderer and public page. PrismaService is global.
 */
@Module({
  imports: [AcademyModule],
  controllers: [AcademyMediaController],
  providers: [
    AcademySiteConfig,
    AiClient,
    AiJobService,
    AiJobWorker,
    AcademyMediaProcessor,
    AcademyMediaService,
    MediaMaintenanceWorker,
    // Handler registry — empty until Slice 5 registers SITE_GENERATE.
    { provide: AI_JOB_HANDLERS, useValue: [] },
  ],
  exports: [AcademySiteConfig, AiClient, AiJobService, AcademyMediaService],
})
export class AcademySiteModule {}

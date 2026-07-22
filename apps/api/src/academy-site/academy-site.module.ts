import { Module } from '@nestjs/common';
import { AcademySiteConfig } from './academy-site.config';
import { AiClient } from './ai/ai.client';
import { AI_JOB_HANDLERS } from './jobs/ai-job.handler';
import { AiJobService } from './jobs/ai-job.service';
import { AiJobWorker } from './jobs/ai-job.worker';

/**
 * Academy Studio (AI site) module. Slice 2 wires the job infrastructure only;
 * later slices add the generation handler (AI_JOB_HANDLERS), media pipeline,
 * facts/editor APIs, renderer and public page. PrismaService is global.
 */
@Module({
  providers: [
    AcademySiteConfig,
    AiClient,
    AiJobService,
    AiJobWorker,
    // Handler registry — empty until Slice 5 registers SITE_GENERATE.
    { provide: AI_JOB_HANDLERS, useValue: [] },
  ],
  exports: [AcademySiteConfig, AiClient, AiJobService],
})
export class AcademySiteModule {}

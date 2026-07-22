import { Module } from '@nestjs/common';
import { AcademyModule } from '../academy/academy.module';
import { AcademySiteConfig } from './academy-site.config';
import { AdminAcademyStudioController } from './admin/admin-academy-studio.controller';
import { AdminAcademyStudioService } from './admin/admin-academy-studio.service';
import { AiFeatureEnabledGuard } from './ai-feature.guard';
import { AcademyFactsController } from './facts/academy-facts.controller';
import { AcademyFactsService } from './facts/academy-facts.service';
import { AcademyGenerateController } from './generation/academy-generate.controller';
import { SiteGenerateHandler } from './generation/site-generate.handler';
import { SiteGeneratorService } from './generation/site-generator.service';
import { PublicSiteController } from './public/public-site.controller';
import { PublicSiteService } from './public/public-site.service';
import { SiteRenderService } from './renderer/site-render.service';
import { AcademySiteController } from './site/academy-site.controller';
import { AcademySiteService } from './site/academy-site.service';
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
  controllers: [
    AcademyMediaController,
    AcademyFactsController,
    AcademyGenerateController,
    AcademySiteController,
    PublicSiteController,
    AdminAcademyStudioController,
  ],
  providers: [
    AcademySiteConfig,
    AiFeatureEnabledGuard,
    AiClient,
    AiJobService,
    AiJobWorker,
    AcademyMediaProcessor,
    AcademyMediaService,
    MediaMaintenanceWorker,
    AcademyFactsService,
    AcademySiteService,
    SiteRenderService,
    PublicSiteService,
    SiteGeneratorService,
    SiteGenerateHandler,
    AdminAcademyStudioService,
    // Job handler registry: the worker dispatches each AiJobType to its handler.
    {
      provide: AI_JOB_HANDLERS,
      useFactory: (siteGenerate: SiteGenerateHandler) => [siteGenerate],
      inject: [SiteGenerateHandler],
    },
  ],
  exports: [
    AcademySiteConfig,
    AiClient,
    AiJobService,
    AcademyMediaService,
    AcademyFactsService,
    AcademySiteService,
    SiteRenderService,
  ],
})
export class AcademySiteModule {}

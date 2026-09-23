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
import { DesignRulesService } from './pipeline/design-rules.service';
import { EvolutionService } from './pipeline/evolution.service';
import { QualityGateService } from './pipeline/quality-gate.service';
import { SiteBrainService } from './pipeline/site-brain.service';
import { PublicSiteController } from './public/public-site.controller';
import { PublicSiteService } from './public/public-site.service';
import { SiteRenderService } from './renderer/site-render.service';
import { AcademySiteController } from './site/academy-site.controller';
import { AcademySiteService } from './site/academy-site.service';
import { AiClient } from './ai/ai.client';
import { AI_JOB_HANDLERS } from './jobs/ai-job.handler';
import { DailyModule } from '../live/daily.module';
import { LiveSummaryHandler } from '../live/live-summary.handler';
import { AiJobService } from './jobs/ai-job.service';
import { AiJobWorker } from './jobs/ai-job.worker';
import { AcademyMediaController } from './media/academy-media.controller';
import { AcademyMediaProcessor } from './media/academy-media.processor';
import { AcademyMediaService } from './media/academy-media.service';
import { MediaMaintenanceWorker } from './media/media-maintenance.worker';
import { StudentPriceService } from '../payments/student-price.service';
import { PaperImportCoreModule } from '../paper-import/paper-import-core.module';
import { PaperExtractionService } from '../paper-import/paper-extraction.service';
import { PaperImportHandler } from '../paper-import/paper-import.handler';
import { ContentGenerationService } from '../paper-import/content-generation.service';
import { QuestionGeneratorService } from '../paper-import/question-generator.service';
import { SourceReaderService } from '../paper-import/source-reader.service';
import { ImageVariantsService } from '../paper-import/ocr/image-variants.service';
import { TranscriberService } from '../paper-import/ocr/transcriber.service';

/**
 * Academy Studio (AI site) module. Slice 2 wires the job infrastructure only;
 * later slices add the generation handler (AI_JOB_HANDLERS), media pipeline,
 * facts/editor APIs, renderer and public page. PrismaService is global.
 */
@Module({
  imports: [AcademyModule, DailyModule, PaperImportCoreModule],
  controllers: [
    AcademyMediaController,
    AcademyFactsController,
    AcademyGenerateController,
    AcademySiteController,
    PublicSiteController,
    AdminAcademyStudioController,
  ],
  providers: [
    StudentPriceService,
    AcademySiteConfig,
    AiFeatureEnabledGuard,
    AiClient,
    AiJobService,
    AiJobWorker,
    LiveSummaryHandler,
    ImageVariantsService,
    TranscriberService,
    PaperExtractionService,
    SourceReaderService,
    QuestionGeneratorService,
    ContentGenerationService,
    PaperImportHandler,
    AcademyMediaProcessor,
    AcademyMediaService,
    MediaMaintenanceWorker,
    AcademyFactsService,
    AcademySiteService,
    DesignRulesService,
    SiteBrainService,
    EvolutionService,
    QualityGateService,
    SiteRenderService,
    PublicSiteService,
    SiteGeneratorService,
    SiteGenerateHandler,
    AdminAcademyStudioService,
    // Job handler registry: the worker dispatches each AiJobType to its handler.
    {
      provide: AI_JOB_HANDLERS,
      // The live summary runs on the same worker as site generation: one queue,
      // one lease, one retry policy.
      useFactory: (
        siteGenerate: SiteGenerateHandler,
        liveSummary: LiveSummaryHandler,
        paperImport: PaperImportHandler,
      ) => [siteGenerate, liveSummary, paperImport],
      inject: [SiteGenerateHandler, LiveSummaryHandler, PaperImportHandler],
    },
  ],
  exports: [
    // The teacher-facing module needs this one for "write question 7 again",
    // which is answered in the request rather than on the queue.
    ContentGenerationService,
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

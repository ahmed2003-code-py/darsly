import { Injectable } from '@nestjs/common';
import { AiJob, AiJobType } from '@prisma/client';
import { AcademySiteConfig } from '../academy-site.config';
import { AiJobHandler, AiJobResult } from '../jobs/ai-job.handler';
import { AiJobService } from '../jobs/ai-job.service';
import { AcademySiteService } from '../site/academy-site.service';
import { SiteGeneratorService } from './site-generator.service';

/** Processes SITE_GENERATE jobs: run the pipeline, store the draft + snapshot. */
@Injectable()
export class SiteGenerateHandler implements AiJobHandler {
  readonly type: AiJobType = 'SITE_GENERATE';

  constructor(
    private readonly generator: SiteGeneratorService,
    private readonly site: AcademySiteService,
    private readonly jobs: AiJobService,
    private readonly config: AcademySiteConfig,
  ) {}

  async handle(job: AiJob): Promise<AiJobResult> {
    const input = job.input as
      | { vibe?: string; stylePrompt?: string; lang?: 'ar' | 'en'; regenerateSectionId?: string }
      | null;

    // Per-section regeneration: rewrite one section, keep the frozen design.
    if (input?.regenerateSectionId) {
      await this.jobs.setStage(job.id, 'section');
      const { doc, costCents } = await this.generator.regenerateSection(job.academyId, input.regenerateSectionId);
      const { snapshot } = await this.site.saveDraft(job.academyId, doc, 'regen-section');
      return { costCents, resultSnapshotId: snapshot.id };
    }

    await this.jobs.setStage(job.id, 'copy');
    // Which pipeline designs the page is a runtime switch, not a deploy: a bad
    // composition release can be turned off without touching the code, and
    // pages already published are unaffected either way because each document
    // is rendered by the engine it was designed against.
    const build = this.config.compositionEnabled
      ? this.generator.buildComposedDraft.bind(this.generator)
      : this.generator.buildDraft.bind(this.generator);
    const { doc, costCents } = await build(
      job.academyId,
      input?.vibe ?? undefined,
      input?.stylePrompt ?? undefined,
      input?.lang ?? undefined,
    );
    await this.jobs.setStage(job.id, 'assemble');
    const { snapshot } = await this.site.saveDraft(job.academyId, doc, 'generate');
    return { costCents, resultSnapshotId: snapshot.id };
  }
}

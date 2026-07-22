import { Injectable } from '@nestjs/common';
import { AiJob, AiJobType } from '@prisma/client';
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
  ) {}

  async handle(job: AiJob): Promise<AiJobResult> {
    const input = job.input as { vibe?: string; stylePrompt?: string } | null;
    await this.jobs.setStage(job.id, 'copy');
    const { doc, costCents } = await this.generator.buildDraft(
      job.academyId,
      input?.vibe ?? undefined,
      input?.stylePrompt ?? undefined,
    );
    await this.jobs.setStage(job.id, 'assemble');
    const { snapshot } = await this.site.saveDraft(job.academyId, doc, 'generate');
    return { costCents, resultSnapshotId: snapshot.id };
  }
}

import { AiJob, AiJobType } from '@prisma/client';

export interface AiJobResult {
  costCents?: number;
  resultSnapshotId?: string;
}

/**
 * A processor for one AiJobType. Slice 5 registers the SITE_GENERATE handler.
 * Throw AiJobError('...', 'TERMINAL' | 'RETRYABLE') to control retry behaviour;
 * any other thrown error is treated as RETRYABLE.
 */
export interface AiJobHandler {
  readonly type: AiJobType;
  handle(job: AiJob): Promise<AiJobResult | void>;
}

/** Multi-provider token: an array of AiJobHandler. Empty until Slice 5. */
export const AI_JOB_HANDLERS = Symbol('AI_JOB_HANDLERS');

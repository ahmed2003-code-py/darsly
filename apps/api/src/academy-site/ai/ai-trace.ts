import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a model call was for, carried to the one place every call goes through.
 *
 * Cost questions are asked per exam, per page, per stage — and the only thing
 * that knows all of those at once is the caller three layers up, while the
 * only thing that sees the provider's usage report is `AiClient`. Threading an
 * import id and a page number through every signature in between would touch
 * every service on the path for a concern none of them has. So the job sets
 * what it knows, each stage adds what it knows, and `AiClient` reads the
 * merged result when it records the call.
 */
export interface AiTrace {
  /** PaperImport.id — one exam-creation session. */
  importId?: string;
  /** The job's phase: READ (pages) or GENERATE (questions). */
  phase?: string;
  /** What this call does, e.g. OCR_PAGE, OCR_REGION, QUESTION_GENERATION. */
  stage?: string;
  pageNumber?: number;
  /** A region or crop inside a page, e.g. "q3". */
  region?: string;
  /** Which batch of questions, for generation. */
  batch?: number;
  /** LiveSession.id — the lesson a summary call was about. */
  liveSessionId?: string;
  /** AiJob.id — ties every attempt of one queued job to its calls. */
  aiJobId?: string;
  /** 0 for the first try at this unit of work, 1 for the next, … */
  attempt?: number;
  /** Anything else worth keeping with the call — small and JSON-safe. */
  meta?: Record<string, unknown>;
}

const store = new AsyncLocalStorage<AiTrace>();

/** Run `fn` with `patch` added to whatever trace is already in force. */
export function withAiTrace<T>(patch: AiTrace, fn: () => Promise<T>): Promise<T> {
  const parent = store.getStore() ?? {};
  const meta = parent.meta || patch.meta ? { ...parent.meta, ...patch.meta } : undefined;
  return store.run({ ...parent, ...patch, ...(meta ? { meta } : {}) }, fn);
}

export function currentAiTrace(): AiTrace {
  return store.getStore() ?? {};
}

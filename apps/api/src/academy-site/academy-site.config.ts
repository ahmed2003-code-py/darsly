import { Injectable } from '@nestjs/common';

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Runtime configuration for the Academy Studio (AI site) feature. Read once from
 * the environment. `enabled` is the master kill-switch — every AI entry point
 * (enqueue, worker, client) checks it, so flipping AI_ACADEMY_ENABLED=false
 * disables the whole feature without a redeploy. Strict prod requirements for
 * these vars are enforced at boot by common/config.validation.ts.
 */
@Injectable()
export class AcademySiteConfig {
  readonly enabled = process.env.AI_ACADEMY_ENABLED === 'true';
  // Backend-only OpenAI credential, read exclusively from the environment.
  readonly apiKey = process.env.OPENAI_API_KEY ?? '';
  readonly model = process.env.AI_MODEL ?? 'gpt-5';
  // Prices are in cents per million tokens.
  readonly priceInPerMToken = num(process.env.AI_PRICE_IN_PER_MTOKEN, 300);
  readonly priceOutPerMToken = num(process.env.AI_PRICE_OUT_PER_MTOKEN, 1500);
  // Month-to-date spend ceiling in cents. 0 = uncapped.
  readonly monthlyBudgetCents = num(process.env.AI_MONTHLY_BUDGET_CENTS, 0);
  // A replica sets WORKER_ENABLED=false to opt out of processing jobs.
  readonly workerEnabled = (process.env.WORKER_ENABLED ?? 'true') === 'true';
  readonly workerConcurrency = Math.max(1, num(process.env.WORKER_CONCURRENCY, 3));
}

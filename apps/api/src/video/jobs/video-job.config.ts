import { Injectable } from '@nestjs/common';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Video worker settings, kept apart from the AI worker's on purpose.
 *
 * `WORKER_ENABLED` / `WORKER_CONCURRENCY` belong to the AI job worker, which
 * runs three jobs at once because its work is a network call to OpenAI that
 * spends almost all of its time waiting. Video packaging is the opposite: an
 * ffmpeg process that saturates a core, on the same container that is serving
 * HTTP. Two at once on a small Railway replica is felt as request latency by
 * every user on it, so this defaults to **one** and has its own name.
 *
 * `VIDEO_WORKER_ENABLED` exists so a replica can be told not to take video
 * work — and so the worker can be stopped in production without a deploy if it
 * ever misbehaves. It defaults to on: a queue nobody drains is worse than the
 * fire-and-forget it replaced.
 */
@Injectable()
export class VideoJobConfig {
  readonly workerEnabled = (process.env.VIDEO_WORKER_ENABLED ?? 'true') === 'true';
  readonly workerConcurrency = Math.max(1, num(process.env.VIDEO_WORKER_CONCURRENCY, 1));
}

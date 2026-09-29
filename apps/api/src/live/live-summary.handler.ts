import { Injectable, Logger } from '@nestjs/common';
import { AiJob, AiJobType, Prisma } from '@prisma/client';
import { AiClient, AiPrice } from '../academy-site/ai/ai.client';
import { AiJobError } from '../academy-site/ai/ai-job.error';
import { withAiTrace } from '../academy-site/ai/ai-trace';
import { AiJobHandler, AiJobResult } from '../academy-site/jobs/ai-job.handler';
import { maxAttemptsFor } from '../academy-site/jobs/ai-job.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiveProviders } from './providers/live-providers';
import {
  estimateTokens,
  FINAL_SCHEMA,
  groundSummary,
  PARTIAL_NOTE,
  SECTION_SCHEMA,
  splitSections,
  SUMMARY_RULES,
  summaryLimits,
} from './summary/grounded-summary';

export type { GroundedSummary } from './summary/grounded-summary';

/**
 * The model the lesson summary runs on, and what it costs (cents per million
 * tokens) — gpt-6-luna at its published $0.10 / $0.50 unless configured
 * otherwise. Chosen by the 2026-09-27 benchmark; see summary/grounded-summary.ts.
 */
export function liveSummaryModel(env: NodeJS.ProcessEnv = process.env): {
  model: string;
  price: AiPrice;
} {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    model: env.LIVE_SUMMARY_MODEL?.trim() || 'gpt-6-luna',
    price: {
      inPerMToken: n('LIVE_SUMMARY_PRICE_IN', 10),
      outPerMToken: n('LIVE_SUMMARY_PRICE_OUT', 50),
    },
  };
}

/** Below this, there is no lesson in the transcript worth summarising. */
const MIN_TRANSCRIPT_CHARS = 80;
/** A retry of a failed summary waits this long (the queue would otherwise retry at once). */
const SUMMARY_RETRY_MS = 60_000;

/**
 * How long one attempt waits for Daily to finish writing its transcript
 * (Daily classes only). Mutable so a test does not have to sit through it.
 */
export const TRANSCRIPT_WAIT = { pollMs: 10_000, maxMs: 3 * 60_000 };

interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * The lesson, written up from what was actually said in it — the transcript
 * is the only source (see summary/grounded-summary.ts for the schema, the
 * rules, and the free evidence check).
 *
 *  - The WHOLE transcript goes to the model. Nothing is cut: a normal class
 *    is one call; an exceptionally large one (or one whose single call cannot
 *    finish) is summarised in sections and merged — by the same model.
 *  - Idempotent per transcript revision: a second delivery, a double press or
 *    a retry of a job that already wrote returns without a model call.
 *  - The result is written only if the words did not change while it was
 *    being made; if they did, the job runs again on the new words.
 *  - A failure here never touches the transcript, and a retry never runs
 *    speech-to-text again.
 */
@Injectable()
export class LiveSummaryHandler implements AiJobHandler {
  readonly type: AiJobType = 'LIVE_SUMMARY';
  private readonly logger = new Logger(LiveSummaryHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClient,
    private readonly providers: LiveProviders,
    private readonly notifications: NotificationsService,
  ) {}

  async handle(job: AiJob): Promise<AiJobResult | void> {
    const liveSessionId = (job.input as { liveSessionId?: string })?.liveSessionId;
    if (!liveSessionId) throw new AiJobError('No liveSessionId on job', 'TERMINAL');
    return withAiTrace({ liveSessionId, aiJobId: job.id, stage: 'LIVE_SUMMARY' }, () =>
      this.run(job, liveSessionId),
    );
  }

  private async run(job: AiJob, liveSessionId: string): Promise<AiJobResult | void> {
    const force = !!(job.input as { force?: boolean })?.force;
    const session = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: {
        id: true,
        title: true,
        roomName: true,
        provider: true,
        transcriptText: true,
        transcriptStatus: true,
        transcriptRevision: true,
        summaryStatus: true,
        summaryMeta: true,
        teacher: { select: { userId: true } },
      },
    });
    if (!session) throw new AiJobError('Session no longer exists', 'TERMINAL');

    // Already written for these words — by this job, or (unless a teacher asked
    // for a new one) by any job.
    const done = session.summaryMeta as { transcriptRevision?: number; jobId?: string } | null;
    if (
      session.summaryStatus === 'READY' &&
      done?.transcriptRevision === session.transcriptRevision &&
      (!force || done.jobId === job.id)
    ) {
      return;
    }

    const t0 = Date.now();
    const lastTry = job.attempts >= maxAttemptsFor(job.type);
    this.logger.log(
      `live.summary.started liveSession=${liveSessionId} job=${job.id} attempt=${job.attempts}`,
    );
    const transcript = await this.transcriptFor(session, lastTry);
    if (!transcript) {
      const unavailable =
        session.provider !== 'CLOUDFLARE' &&
        (session.transcriptStatus === 'FAILED' ||
          (await this.providers.forSession(session).transcripts?.available()) === false);
      const reason = unavailable ? 'TRANSCRIPTION_UNAVAILABLE' : 'NO_TRANSCRIPT';
      // The summary fails; the transcript is left exactly as it is (a short
      // Darsly transcript is still a transcript).
      await this.prisma.liveSession.update({
        where: { id: liveSessionId },
        data: {
          summaryStatus: 'FAILED',
          summaryError: reason,
          ...(session.provider !== 'CLOUDFLARE' ? { transcriptStatus: 'FAILED' as const } : {}),
        },
      });
      this.logger.warn(
        `live.summary.failed liveSession=${liveSessionId} job=${job.id} reason=${reason}`,
      );
      throw new AiJobError(`No transcript available for this session (${reason})`, 'TERMINAL');
    }

    const priorMillicents = Math.max(await this.spentByJob(job.id), (job.costCents ?? 0) * 1000);
    const { model, price } = liveSummaryModel();
    const partial = session.transcriptStatus === 'PARTIAL';
    const calls: Usage[] = [];
    let spent = 0;
    const charge = async (u: Usage) => {
      calls.push(u);
      spent += this.ai.costMillicents(u.inputTokens, u.outputTokens, price);
      await this.chargeJob(job.id, priorMillicents + spent);
    };

    let path: 'single' | 'sections';
    let data: Record<string, unknown>;
    try {
      ({ path, data } = await this.generate(
        session.title,
        transcript,
        partial,
        model,
        price,
        charge,
      ));
    } catch (e) {
      const usage = e instanceof AiJobError ? e.usage : undefined;
      if (usage) spent += this.ai.costMillicents(usage.inputTokens, usage.outputTokens, price);
      await this.chargeJob(job.id, priorMillicents + spent);
      // Still being worked on until the last attempt: the page keeps saying so
      // rather than flashing "failed" between retries.
      if (lastTry) {
        await this.prisma.liveSession.update({
          where: { id: liveSessionId },
          data: { summaryStatus: 'FAILED', summaryError: 'AI_FAILED' },
        });
      }
      this.logger.warn(
        `live.summary.failed liveSession=${liveSessionId} job=${job.id} reason=AI_FAILED last=${lastTry}`,
      );
      throw new AiJobError(
        `Summary generation failed: ${(e as Error).message}`,
        'RETRYABLE',
        undefined,
        SUMMARY_RETRY_MS,
      );
    }

    const grounded = groundSummary(data, transcript);
    const totals = calls.reduce(
      (s, c) => ({
        inputTokens: s.inputTokens + c.inputTokens,
        outputTokens: s.outputTokens + c.outputTokens,
        reasoningTokens: s.reasoningTokens + c.reasoningTokens,
      }),
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    );
    const summaryMeta = {
      model,
      path,
      calls: calls.length,
      ...totals,
      costMillicents: spent,
      transcriptRevision: session.transcriptRevision,
      partial,
      dropped: grounded.dropped,
      kept: grounded.kept,
      jobId: job.id,
      generatedAt: new Date().toISOString(),
      ms: Date.now() - t0,
    };
    // Only for the words it was made from: if the transcript changed meanwhile
    // (a recovered piece), this summary is already stale — make it again.
    const ownCopy = session.provider !== 'CLOUDFLARE' && transcript !== session.transcriptText;
    const written = await this.prisma.liveSession.updateMany({
      where: { id: liveSessionId, transcriptRevision: session.transcriptRevision },
      data: {
        summary: grounded.summary as unknown as Prisma.InputJsonValue,
        summaryStatus: 'READY',
        summaryError: null,
        summaryMeta: summaryMeta as unknown as Prisma.InputJsonValue,
        // A Daily class's words are kept once fetched: its provider's copy expires.
        ...(ownCopy
          ? {
              transcriptText: transcript,
              transcriptStatus: 'READY' as const,
              transcriptRevision: { increment: 1 },
              summaryMeta: {
                ...summaryMeta,
                transcriptRevision: session.transcriptRevision + 1,
              } as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (written.count === 0) {
      this.logger.log(
        `live.summary.stale liveSession=${liveSessionId} job=${job.id}: transcript changed, regenerating`,
      );
      throw new AiJobError(
        'The transcript changed while the summary was made',
        'RETRYABLE',
        undefined,
        5_000,
      );
    }

    await this.notifications
      .create({
        userId: session.teacher.userId,
        type: 'LIVE_SESSION_REMINDER',
        title: 'ملخّص الحصة جاهز 🤖',
        body: `ملخّص «${session.title}» اتولّد. راجعه قبل ما تشاركه مع الطلبة.`,
        meta: { sessionId: liveSessionId, summary: true },
      })
      .catch(() => undefined);
    const costCents = Math.ceil((priorMillicents + spent) / 1000);
    this.logger.log(
      `live.summary.ready liveSession=${liveSessionId} job=${job.id} model=${model} path=${path} calls=${calls.length} ` +
        `in=${totals.inputTokens} out=${totals.outputTokens} dropped=${JSON.stringify(grounded.dropped)} partial=${partial} ` +
        `costMillicents=${spent} ms=${Date.now() - t0}`,
    );
    return { costCents };
  }

  /**
   * One call over the whole transcript; sections → merge only when it is too
   * large for one call or one call could not finish. Never a cut.
   */
  private async generate(
    title: string,
    transcript: string,
    partial: boolean,
    model: string,
    price: AiPrice,
    charge: (u: Usage) => Promise<void>,
  ): Promise<{ path: 'single' | 'sections'; data: Record<string, unknown> }> {
    const lim = summaryLimits();
    const system = partial ? `${SUMMARY_RULES}\n${PARTIAL_NOTE}` : SUMMARY_RULES;
    const ask = async (user: string, schemaName: string, schema: object, maxTokens: number) => {
      const r = await this.ai.completeStructured<Record<string, unknown>>({
        system,
        messages: [{ role: 'user', content: user }],
        schemaName,
        schema: schema as Record<string, unknown>,
        maxTokens,
        model,
        price,
        reasoningEffort: 'low',
        store: false,
        timeoutMs: 5 * 60_000,
        maxRetries: 1,
      });
      await charge({
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens ?? 0,
      });
      return r.data;
    };
    const cutOff = (e: unknown) => e instanceof AiJobError && /cut off/i.test(e.message);
    const whole = `Class title: ${title}\n\n<<<TRANSCRIPT>>>\n${transcript}\n<<<END TRANSCRIPT>>>`;

    const parts = splitSections(transcript, lim.sectionMaxTokens);
    if (estimateTokens(transcript) <= lim.singleCallMaxTokens) {
      let last: unknown;
      for (const cap of [lim.singleCallOutput, lim.singleCallOutput * 2]) {
        try {
          return { path: 'single', data: await ask(whole, 'class_study_notes', FINAL_SCHEMA, cap) };
        } catch (e) {
          if (!cutOff(e)) throw e;
          last = e;
          const u = (e as AiJobError).usage;
          if (u)
            await charge({
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              reasoningTokens: 0,
            });
        }
      }
      // Two cut-off answers: too rich for one answer — sections, if there is
      // more than one section to make (one section would be the same call again).
      if (parts.length < 2) throw new AiJobError((last as Error).message, 'RETRYABLE');
    }
    const notes: Record<string, unknown>[] = [];
    for (const [i, part] of parts.entries()) {
      const user = `Class title: ${title}\nPart ${i + 1} of ${parts.length} of the class, in order.\n\n<<<TRANSCRIPT PART>>>\n${part}\n<<<END TRANSCRIPT PART>>>`;
      notes.push({
        part: i + 1,
        ...(await ask(user, 'class_section_notes', SECTION_SCHEMA, lim.sectionOutput)),
      });
    }
    const merge =
      `Class title: ${title}\nBelow are notes on each part of ONE class, in order. Merge them into the final study notes. ` +
      `Use only what the notes contain; keep each item's evidence quote exactly as given; drop duplicates; ` +
      `a later correction overrides an earlier statement.\n\n${JSON.stringify(notes)}`;
    return {
      path: 'sections',
      data: await ask(merge, 'class_study_notes', FINAL_SCHEMA, lim.mergeOutput),
    };
  }

  private async spentByJob(aiJobId: string): Promise<number> {
    try {
      const agg = await this.prisma.aiCallLog.aggregate({
        where: { aiJobId },
        _sum: { costMillicents: true },
      });
      return agg._sum.costMillicents ?? 0;
    } catch (e) {
      this.logger.warn(`Could not read prior AI spend for job ${aiJobId}: ${(e as Error).message}`);
      return 0;
    }
  }

  private async chargeJob(aiJobId: string, millicents: number): Promise<void> {
    if (millicents <= 0) return;
    await this.prisma.aiJob
      .update({ where: { id: aiJobId }, data: { costCents: Math.ceil(millicents / 1000) } })
      .catch((e: Error) =>
        this.logger.warn(`Could not record AI spend on job ${aiJobId}: ${e.message}`),
      );
  }

  /**
   * The words: Darsly's own transcript when it has one (Cloudflare — the only
   * source there), else fetched from the provider (Daily), waiting a while for
   * a transcript still being written.
   */
  private async transcriptFor(
    session: {
      id: string;
      transcriptText: string | null;
      roomName: string | null;
      provider?: string | null;
    },
    lastTry: boolean,
  ): Promise<string | null> {
    const own = session.transcriptText?.trim();
    if (own && own.length >= MIN_TRANSCRIPT_CHARS) return own;
    const transcripts =
      session.provider === 'CLOUDFLARE' ? null : this.providers.forSession(session).transcripts;
    if (!session.roomName || !transcripts) return null;
    const deadline = Date.now() + TRANSCRIPT_WAIT.maxMs;
    for (;;) {
      const found = await transcripts.find(session.roomName);
      if (found.state === 'ready')
        return found.text.length >= MIN_TRANSCRIPT_CHARS ? found.text : null;
      if (found.state === 'none') return null;
      if (found.state === 'error') {
        if (lastTry) await this.giveUp(session.id, 'PROVIDER_UNREACHABLE');
        throw new AiJobError(
          'Could not reach the transcript provider',
          'RETRYABLE',
          undefined,
          SUMMARY_RETRY_MS,
        );
      }
      if (Date.now() >= deadline) {
        if (lastTry) await this.giveUp(session.id, 'TRANSCRIPT_PENDING');
        throw new AiJobError(
          'Transcript is still being processed by the provider',
          'RETRYABLE',
          undefined,
          SUMMARY_RETRY_MS,
        );
      }
      await new Promise((r) => setTimeout(r, TRANSCRIPT_WAIT.pollMs));
    }
  }

  private giveUp(sessionId: string, reason: string) {
    return this.prisma.liveSession.update({
      where: { id: sessionId },
      data: { summaryStatus: 'FAILED', summaryError: reason },
    });
  }
}

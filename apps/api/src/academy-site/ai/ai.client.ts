import { Injectable, Logger, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../academy-site.config';
import { AiJobError } from './ai-job.error';
import { currentAiTrace } from './ai-trace';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Images to read alongside the text, as `data:` URLs.
   *
   * Used to read a transfer receipt a student uploaded: the numbers on it are
   * evidence, and there is no other way to get at them. Passed through to the
   * Responses API as `input_image` parts on the same message, so the model sees
   * the picture and the instruction together.
   */
  images?: string[];
}

export interface AiCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface AiStructuredResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** Part of inputTokens / outputTokens, reported separately when known. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

type ContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: AiImageDetail };
type InputMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

/**
 * How hard the provider looks at a picture.
 *
 * `low` resizes to 512x512 and is for "is there a cat in this". `high` fits
 * the model's own patch budget. `original` keeps the picture as sent (up to
 * the model's limits) and is what the provider's own guide recommends for
 * optical character recognition and small detail — which is exactly what
 * reading a question off an exam paper is.
 */
export type AiImageDetail = 'auto' | 'low' | 'high' | 'original';

/** GPT-5 / GPT-6 / o-series are reasoning models: they use the default
 *  temperature only (a custom value returns 400) and benefit from an explicit
 *  reasoning effort.
 *
 *  GPT-6 was missing from this test, which meant a deployment that set
 *  AI_MODEL to one of them sent `temperature` and got a 400 back from every
 *  call. Matching the family rather than a list of ids, so the next point
 *  release does not have to be added here. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-[5-9]|o\d)/i.test(model);
}

/** Per-million-token prices, in cents. Callers that read a different model
 *  than AI_MODEL pass their own, so cost stays right per call. */
export interface AiPrice {
  inPerMToken: number;
  outPerMToken: number;
}

/** How hard the model thinks before answering. Cheap work asks for less. */
export type AiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Options every call shares. `model` overrides AI_MODEL for this call only —
 *  that is what lets one feature read pages on a cheap model and escalate a
 *  single page to an expensive one without a second client. */
interface AiCallOverrides {
  model?: string;
  price?: AiPrice;
  reasoningEffort?: AiReasoningEffort;
  /** `low` costs a fraction of `high` and is enough for a picture that is
   *  only being looked at, not read; `original` is for reading text off one.
   *  Defaults to `high`, which is what every existing caller was getting. */
  imageDetail?: AiImageDetail;
  /**
   * How long one call may take, and how many times the SDK may retry it.
   * Left unset, the SDK's own defaults apply — ten minutes and two retries —
   * which is right for a site generation nobody is watching and wrong for a
   * page a teacher is waiting on: one stalled call could hold a page for half
   * an hour. Callers on a waiting person's path set both.
   */
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Provider wrapper over the OpenAI **Responses API** (the API OpenAI recommends
 * for GPT-5 and reasoning models). The provider is swappable behind this
 * interface — the job queue, pipeline, retries, budgeting and metering never
 * depend on the SDK. Cost is computed from reported token usage.
 *
 * `completeStructured()` uses Structured Outputs (strict json_schema) so the
 * model is constrained to return schema-valid JSON — no free-form JSON parsing
 * and no malformed-JSON retries.
 *
 * Key handling: the API key is read from AcademySiteConfig (env only), used only
 * to construct the client, and NEVER logged, returned, stored, or placed in an
 * error. redact() strips any key-like token from provider error text.
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);
  private client: OpenAI | null = null;

  constructor(
    private readonly config: AcademySiteConfig,
    /** Where every call is recorded (AiCallLog). Optional so a unit test can
     *  build a client without a database; in the app it is always there. */
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /** Cost in whole cents for a given token usage (prices are per million
   *  tokens). Without a `price` the configured AI_MODEL prices are used, which
   *  is what every caller before per-call models got. */
  costCents(inputTokens: number, outputTokens: number, price?: AiPrice): number {
    const inPerM = price?.inPerMToken ?? this.config.priceInPerMToken;
    const outPerM = price?.outPerMToken ?? this.config.priceOutPerMToken;
    const cents = (inputTokens / 1_000_000) * inPerM + (outputTokens / 1_000_000) * outPerM;
    return Math.ceil(cents);
  }

  /**
   * Cost in thousandths of a cent.
   *
   * `costCents` rounds up to a whole cent, which is right for a job that costs
   * dollars and wrong for a page that costs a fifth of a cent: rounding every
   * page up to 1¢ made a ten-page import look like 10¢ when it cost 2. Pages
   * are metered in millicents and only the total is rounded.
   */
  costMillicents(inputTokens: number, outputTokens: number, price?: AiPrice): number {
    const inPerM = price?.inPerMToken ?? this.config.priceInPerMToken;
    const outPerM = price?.outPerMToken ?? this.config.priceOutPerMToken;
    return Math.round(
      ((inputTokens / 1_000_000) * inPerM + (outputTokens / 1_000_000) * outPerM) * 1000,
    );
  }

  /** Free-text completion (interface preserved). */
  async complete(
    opts: {
      system?: string;
      messages: AiMessage[];
      maxTokens?: number;
      temperature?: number;
    } & AiCallOverrides,
  ): Promise<AiCompletion> {
    const startedAt = new Date();
    let resp: any = null;
    try {
      resp = await this.callResponses(opts);
    } catch (e) {
      this.record(opts, startedAt, null, 'failed', (e as Error).message);
      throw e;
    }
    this.record(opts, startedAt, resp, 'ok', null);
    const text: string = resp.output_text ?? '';
    const { inputTokens, outputTokens } = this.usage(resp);
    return {
      text,
      inputTokens,
      outputTokens,
      costCents: this.costCents(inputTokens, outputTokens, opts.price),
    };
  }

  /**
   * Structured completion. `schema` is a strict JSON Schema; the model is
   * guaranteed to return JSON matching it (or a refusal). Returns the parsed
   * object — the caller never parses free-form text.
   */
  async completeStructured<T = unknown>(
    opts: {
      system?: string;
      messages: AiMessage[];
      maxTokens?: number;
      schemaName: string;
      schema: Record<string, unknown>;
    } & AiCallOverrides,
  ): Promise<AiStructuredResult<T>> {
    const startedAt = new Date();
    let resp: any = null;
    // What went wrong, when something did — named just before each throw, so
    // the call's record says "cut off" rather than lumping every failure in
    // with a network error. Every call is recorded exactly once: here on
    // failure, below on success.
    let outcome = 'failed';
    try {
      resp = await this.callResponses({
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        imageDetail: opts.imageDetail,
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        format: { name: opts.schemaName, schema: opts.schema },
      });
      const result = this.structuredFrom<T>(resp, opts.price, (o) => (outcome = o));
      this.record(opts, startedAt, resp, 'ok', null);
      return result;
    } catch (e) {
      this.record(opts, startedAt, resp, outcome, (e as Error).message);
      throw e;
    }
  }

  /** The checks on a structured response, in order. `mark` names what failed
   *  before it is thrown, so the call's record carries the reason. */
  private structuredFrom<T>(
    resp: any,
    price: AiPrice | undefined,
    mark: (outcome: string) => void,
  ): AiStructuredResult<T> {
    const text: string = resp.output_text ?? '';
    const refusal = this.extractRefusal(resp);
    if (refusal) {
      mark('refused');
      throw new AiJobError(
        `AI refused the request: ${this.redact(refusal)}`,
        'TERMINAL',
        this.usage(resp),
      );
    }

    /**
     * Truncation, checked before parsing rather than only when the output is
     * empty.
     *
     * A response cut off at the token ceiling does not come back empty — it
     * comes back as half a JSON document, which then failed `JSON.parse` and
     * was reported as "Structured output was not valid JSON". Production spent
     * a page on that message: the retry policy was wrong (raising the ceiling
     * would have fixed it, trying again would not), and the diagnosis sent
     * everyone looking for a schema bug that was not there.
     */
    if (resp.status === 'incomplete') {
      const why = resp.incomplete_details?.reason ?? 'unknown';
      mark('incomplete');
      throw new AiJobError(
        `AI response was cut off before it finished (${why}); raise max_output_tokens`,
        'RETRYABLE',
        this.usage(resp),
      );
    }
    if (!text) {
      mark('empty');
      throw new AiJobError('AI returned empty output', 'RETRYABLE', this.usage(resp));
    }

    let data: T;
    try {
      // Schema-valid JSON under Structured Outputs; a parse failure here means
      // the contract was not honoured, not that the text needs repairing.
      data = JSON.parse(text) as T;
    } catch (e) {
      // Enough to tell a truncation from a prose answer from an empty object,
      // without putting the document itself in a log.
      mark('invalid_json');
      throw new AiJobError(
        `Structured output was not valid JSON ` +
          `(status=${resp.status ?? 'n/a'}, ${text.length} chars, ` +
          `starts ${JSON.stringify(text.slice(0, 24))}, ends ${JSON.stringify(text.slice(-24))}, ` +
          `${(e as Error).message})`,
        'RETRYABLE',
        this.usage(resp),
      );
    }
    const { inputTokens, outputTokens, cachedInputTokens, reasoningTokens } = this.usage(resp);
    return {
      data,
      inputTokens,
      outputTokens,
      costCents: this.costCents(inputTokens, outputTokens, price),
      cachedInputTokens,
      reasoningTokens,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async callResponses(
    opts: {
      system?: string;
      messages: AiMessage[];
      maxTokens?: number;
      temperature?: number;
      format?: { name: string; schema: Record<string, unknown> };
    } & AiCallOverrides,
  ): Promise<any> {
    if (!this.config.enabled) {
      throw new AiJobError('AI feature is disabled (AI_ACADEMY_ENABLED)', 'TERMINAL');
    }
    if (!this.config.apiKey) {
      throw new AiJobError('OPENAI_API_KEY is not configured', 'TERMINAL');
    }
    const model = opts.model || this.config.model;
    const reasoning = isReasoningModel(model);
    const detail = opts.imageDetail ?? 'high';

    const input: InputMessage[] = [];
    if (opts.system) input.push({ role: 'system', content: opts.system });
    for (const m of opts.messages) {
      input.push(
        m.images?.length
          ? {
              role: m.role,
              content: [
                { type: 'input_text', text: m.content },
                ...m.images.map((image_url) => ({
                  type: 'input_image' as const,
                  image_url,
                  detail,
                })),
              ],
            }
          : { role: m.role, content: m.content },
      );
    }

    const params: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: opts.maxTokens ?? 2000,
    };
    if (opts.temperature != null && !reasoning) params.temperature = opts.temperature;
    if (reasoning) params.reasoning = { effort: opts.reasoningEffort ?? 'low' };
    if (opts.format) {
      params.text = {
        format: {
          type: 'json_schema',
          name: opts.format.name,
          strict: true,
          schema: opts.format.schema,
        },
      };
    }

    try {
      const requestOptions = {
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(opts.maxRetries != null ? { maxRetries: opts.maxRetries } : {}),
      };
      return await this.getClient().responses.create(params as any, requestOptions);
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const terminal =
        typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      throw new AiJobError(
        `OpenAI request failed${status ? ` (${status})` : ''}: ${this.redact(String(e?.message ?? e))}`,
        terminal ? 'TERMINAL' : 'RETRYABLE',
      );
    }
  }

  /**
   * The provider's usage report. `cachedInputTokens` is part of
   * `inputTokens`, and `reasoningTokens` part of `outputTokens` — both billed
   * inside those totals, reported separately so neither is invisible.
   */
  private usage(resp: any): {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
  } {
    return {
      inputTokens: resp?.usage?.input_tokens ?? 0,
      outputTokens: resp?.usage?.output_tokens ?? 0,
      cachedInputTokens: resp?.usage?.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: resp?.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  /**
   * One AiCallLog row for this call, with whatever the caller's trace says it
   * was for (see ai-trace.ts).
   *
   * Never awaited and never allowed to throw: a teacher's page must not fail
   * because a cost record could not be written. A failed call is recorded too
   * — with the usage the provider reported if a response arrived (a truncated
   * answer is billed in full), or none if it did not.
   */
  private record(
    opts: { messages: AiMessage[]; maxTokens?: number; schemaName?: string } & AiCallOverrides,
    startedAt: Date,
    resp: any,
    status: string,
    error: string | null,
  ): void {
    if (!this.prisma) return;
    try {
      const trace = currentAiTrace();
      const model = opts.model || this.config.model;
      const u = this.usage(resp);
      const price = opts.price ?? {
        inPerMToken: this.config.priceInPerMToken,
        outPerMToken: this.config.priceOutPerMToken,
      };
      const imageCount = opts.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      void this.prisma.aiCallLog
        .create({
          data: {
            importId: trace.importId ?? null,
            phase: trace.phase ?? null,
            stage: trace.stage ?? null,
            pageNumber: trace.pageNumber ?? null,
            region: trace.region ?? null,
            batch: trace.batch ?? null,
            attempt: trace.attempt ?? null,
            model,
            reasoningEffort: isReasoningModel(model) ? (opts.reasoningEffort ?? 'low') : null,
            imageDetail: imageCount ? (opts.imageDetail ?? 'high') : null,
            schemaName: opts.schemaName ?? null,
            imageCount,
            maxOutputTokens: opts.maxTokens ?? 2000,
            startedAt,
            latencyMs: Date.now() - startedAt.getTime(),
            status,
            error: error ? this.redact(error).slice(0, 500) : null,
            responseId: typeof resp?.id === 'string' ? resp.id : null,
            inputTokens: u.inputTokens,
            cachedInputTokens: u.cachedInputTokens,
            outputTokens: u.outputTokens,
            reasoningTokens: u.reasoningTokens,
            priceInPerMToken: price.inPerMToken,
            priceOutPerMToken: price.outPerMToken,
            costMillicents: this.costMillicents(u.inputTokens, u.outputTokens, price),
            ...(trace.meta ? { meta: trace.meta as object } : {}),
          },
        })
        .catch((e: Error) => this.logger.warn(`Could not record an AI call: ${e.message}`));
    } catch (e) {
      this.logger.warn(`Could not record an AI call: ${(e as Error).message}`);
    }
  }

  private extractRefusal(resp: any): string | null {
    for (const item of resp?.output ?? []) {
      for (const c of item?.content ?? []) {
        if (c?.type === 'refusal' && typeof c.refusal === 'string') return c.refusal;
      }
    }
    return null;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      // apiKey comes only from the environment (AcademySiteConfig); never hardcoded.
      this.client = new OpenAI({ apiKey: this.config.apiKey });
    }
    return this.client;
  }

  /** Remove the configured key and any key-like token from a string so it can
   *  never reach a log line, job record, audit entry, or API response. */
  private redact(text: string): string {
    let out = text;
    if (this.config.apiKey) out = out.split(this.config.apiKey).join('***');
    return out.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  }
}

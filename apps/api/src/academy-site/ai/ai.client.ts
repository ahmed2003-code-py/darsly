import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AcademySiteConfig } from '../academy-site.config';
import { AiJobError } from './ai-job.error';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
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
}

type InputMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** GPT-5 / o-series are reasoning models: they use the default temperature only
 *  (a custom value returns 400) and benefit from an explicit reasoning effort. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
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

  constructor(private readonly config: AcademySiteConfig) {}

  /** Cost in whole cents for a given token usage (prices are per million tokens). */
  costCents(inputTokens: number, outputTokens: number): number {
    const cents =
      (inputTokens / 1_000_000) * this.config.priceInPerMToken +
      (outputTokens / 1_000_000) * this.config.priceOutPerMToken;
    return Math.ceil(cents);
  }

  /** Free-text completion (interface preserved). */
  async complete(opts: {
    system?: string;
    messages: AiMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AiCompletion> {
    const resp = await this.callResponses(opts);
    const text: string = resp.output_text ?? '';
    const { inputTokens, outputTokens } = this.usage(resp);
    return { text, inputTokens, outputTokens, costCents: this.costCents(inputTokens, outputTokens) };
  }

  /**
   * Structured completion. `schema` is a strict JSON Schema; the model is
   * guaranteed to return JSON matching it (or a refusal). Returns the parsed
   * object — the caller never parses free-form text.
   */
  async completeStructured<T = unknown>(opts: {
    system?: string;
    messages: AiMessage[];
    maxTokens?: number;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<AiStructuredResult<T>> {
    const resp = await this.callResponses({
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      format: { name: opts.schemaName, schema: opts.schema },
    });

    const text: string = resp.output_text ?? '';
    if (!text) {
      const refusal = this.extractRefusal(resp);
      if (refusal) throw new AiJobError(`AI refused the request: ${this.redact(refusal)}`, 'TERMINAL');
      if (resp.status === 'incomplete') {
        throw new AiJobError('AI response was truncated (token budget)', 'RETRYABLE');
      }
      throw new AiJobError('AI returned empty output', 'RETRYABLE');
    }
    let data: T;
    try {
      // Guaranteed schema-valid JSON under Structured Outputs; parse is safe.
      data = JSON.parse(text) as T;
    } catch {
      throw new AiJobError('Structured output was not valid JSON', 'RETRYABLE');
    }
    const { inputTokens, outputTokens } = this.usage(resp);
    return { data, inputTokens, outputTokens, costCents: this.costCents(inputTokens, outputTokens) };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async callResponses(opts: {
    system?: string;
    messages: AiMessage[];
    maxTokens?: number;
    temperature?: number;
    format?: { name: string; schema: Record<string, unknown> };
  }): Promise<any> {
    if (!this.config.enabled) {
      throw new AiJobError('AI feature is disabled (AI_ACADEMY_ENABLED)', 'TERMINAL');
    }
    if (!this.config.apiKey) {
      throw new AiJobError('OPENAI_API_KEY is not configured', 'TERMINAL');
    }
    const model = this.config.model;
    const reasoning = isReasoningModel(model);

    const input: InputMessage[] = [];
    if (opts.system) input.push({ role: 'system', content: opts.system });
    for (const m of opts.messages) input.push({ role: m.role, content: m.content });

    const params: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: opts.maxTokens ?? 2000,
    };
    if (opts.temperature != null && !reasoning) params.temperature = opts.temperature;
    if (reasoning) params.reasoning = { effort: 'low' };
    if (opts.format) {
      params.text = {
        format: { type: 'json_schema', name: opts.format.name, strict: true, schema: opts.format.schema },
      };
    }

    try {
      return await this.getClient().responses.create(params as any);
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const terminal = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      throw new AiJobError(
        `OpenAI request failed${status ? ` (${status})` : ''}: ${this.redact(String(e?.message ?? e))}`,
        terminal ? 'TERMINAL' : 'RETRYABLE',
      );
    }
  }

  private usage(resp: any): { inputTokens: number; outputTokens: number } {
    return {
      inputTokens: resp?.usage?.input_tokens ?? 0,
      outputTokens: resp?.usage?.output_tokens ?? 0,
    };
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

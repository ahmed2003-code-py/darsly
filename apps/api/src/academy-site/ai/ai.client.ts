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

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * GPT-5 / o-series models only accept the default temperature; sending a custom
 * value returns 400. We forward `temperature` only for models that support it.
 */
function modelUsesDefaultTemperature(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/**
 * Thin wrapper over the OpenAI Chat Completions API. The provider is swappable
 * behind this interface — the job queue, pipeline, retries, budgeting and
 * metering never depend on the SDK. Cost is computed from reported token usage.
 *
 * Key handling: the API key is read from AcademySiteConfig (env only), used to
 * construct the client, and NEVER logged, returned, stored, or placed in an
 * error. redact() strips any key-like token from provider error text before it
 * can propagate into job records, responses, or logs.
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

  async complete(opts: {
    system?: string;
    messages: AiMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AiCompletion> {
    if (!this.config.enabled) {
      throw new AiJobError('AI feature is disabled (AI_ACADEMY_ENABLED)', 'TERMINAL');
    }
    if (!this.config.apiKey) {
      throw new AiJobError('OPENAI_API_KEY is not configured', 'TERMINAL');
    }

    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

    let resp: OpenAI.Chat.Completions.ChatCompletion;
    try {
      resp = await this.getClient().chat.completions.create({
        model: this.config.model,
        max_completion_tokens: opts.maxTokens ?? 2000,
        ...(opts.temperature != null && !modelUsesDefaultTemperature(this.config.model)
          ? { temperature: opts.temperature }
          : {}),
        messages,
      });
    } catch (e: any) {
      // 4xx (except 429) is a request problem → terminal; 429/5xx/network → retryable.
      const status = e?.status ?? e?.response?.status;
      const terminal = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      throw new AiJobError(
        `OpenAI request failed${status ? ` (${status})` : ''}: ${this.redact(String(e?.message ?? e))}`,
        terminal ? 'TERMINAL' : 'RETRYABLE',
      );
    }

    const text = resp.choices?.[0]?.message?.content ?? '';
    const inputTokens = resp.usage?.prompt_tokens ?? 0;
    const outputTokens = resp.usage?.completion_tokens ?? 0;
    return { text, inputTokens, outputTokens, costCents: this.costCents(inputTokens, outputTokens) };
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

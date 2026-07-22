import { Injectable, Logger } from '@nestjs/common';
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

/**
 * Thin wrapper over the Anthropic Messages API. The SDK is lazy-required (like
 * the S3 storage driver) so the API builds and boots without the dependency
 * until the feature is enabled — install it with:
 *   npm i @anthropic-ai/sdk --workspace=apps/api
 * Cost is computed from reported token usage and returned to the caller so the
 * job/budget layer can account for spend.
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);
  // Cached SDK constructor after the first successful lazy-require.
  private ClientCtor: any;

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
      throw new AiJobError('ANTHROPIC_API_KEY is not configured', 'TERMINAL');
    }
    const client = this.client();
    let resp: any;
    try {
      resp = await client.messages.create({
        model: this.config.model,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature,
        system: opts.system,
        messages: opts.messages,
      });
    } catch (e: any) {
      // 4xx (except 429) is a request problem → terminal; 429/5xx/network → retryable.
      const status = e?.status ?? e?.response?.status;
      const terminal = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
      throw new AiJobError(
        `Anthropic request failed${status ? ` (${status})` : ''}: ${e?.message ?? e}`,
        terminal ? 'TERMINAL' : 'RETRYABLE',
      );
    }
    const text: string = (resp.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const inputTokens = resp.usage?.input_tokens ?? 0;
    const outputTokens = resp.usage?.output_tokens ?? 0;
    return { text, inputTokens, outputTokens, costCents: this.costCents(inputTokens, outputTokens) };
  }

  private client(): any {
    if (this.ClientCtor) return new this.ClientCtor({ apiKey: this.config.apiKey });
    let mod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('@anthropic-ai/sdk');
    } catch {
      throw new AiJobError(
        'AI_ACADEMY_ENABLED=true requires @anthropic-ai/sdk. Run: npm i @anthropic-ai/sdk --workspace=apps/api',
        'TERMINAL',
      );
    }
    this.ClientCtor = mod.default ?? mod.Anthropic ?? mod;
    return new this.ClientCtor({ apiKey: this.config.apiKey });
  }
}

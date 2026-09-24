import { AcademySiteConfig } from '../academy-site.config';
import { AiClient } from './ai.client';
import { AiJobError } from './ai-job.error';
import { withAiTrace } from './ai-trace';

/**
 * What the client says went wrong.
 *
 * The message is not decoration: it is what decides whether the job is retried
 * as-is, retried with a bigger ceiling, or given up on. A run that was cut off
 * at the token limit and a run that came back as prose both fail `JSON.parse`,
 * and calling them the same thing sent production looking for a schema bug
 * that did not exist.
 */
describe('reporting why a structured call failed', () => {
  const config = {
    enabled: true,
    apiKey: 'test-key',
    model: 'gpt-6-luna',
  } as unknown as AcademySiteConfig;

  const clientReturning = (resp: Record<string, unknown>) => {
    const client = new AiClient(config);
    (client as unknown as { client: unknown }).client = {
      responses: { create: jest.fn().mockResolvedValue(resp) },
    };
    return client;
  };

  const call = (client: AiClient) =>
    client.completeStructured({
      messages: [{ role: 'user', content: 'read this' }],
      schemaName: 'thing',
      schema: { type: 'object' },
    });

  const usage = { input_tokens: 100, output_tokens: 50 };

  it('names truncation as truncation, and asks for a bigger ceiling', async () => {
    // Half a JSON document. It parses as nothing, but the cure is a larger
    // max_output_tokens, not another identical attempt.
    const client = clientReturning({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '{"regions":[{"label":"1","text":"ما هي عاص',
      usage,
    });

    await expect(call(client)).rejects.toThrow(/cut off/i);
    await expect(call(client)).rejects.toThrow(/max_output_tokens/);
  });

  it('checks truncation before parsing, not only when the output was empty', async () => {
    // The old order asked "is the text empty?" first, so a truncated response
    // — which is never empty — fell through to the parser and was reported as
    // malformed output.
    const client = clientReturning({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '{"questions":[',
      usage,
    });

    await expect(call(client)).rejects.not.toThrow(/not valid JSON/i);
  });

  it('describes malformed output without putting the document in the log', async () => {
    const client = clientReturning({
      status: 'completed',
      output_text:
        'I am sorry, I cannot read this page. Question 3 asks about a pension of ' +
        '128 pounds, and the handwriting below it is too faint to make out.',
      usage,
    });

    const err = await call(client).catch((e: AiJobError) => e);

    expect(String(err)).toMatch(/not valid JSON/i);
    expect(String(err)).toMatch(/status=completed/);
    expect(String(err)).toMatch(/\d+ chars/);
    // The first and last few characters only — enough to tell prose from a
    // truncation from an empty object, not enough to leak a paper.
    expect(String(err)).not.toContain('128 pounds');
  });

  it('treats a refusal as terminal — trying again would refuse again', async () => {
    const client = clientReturning({
      status: 'completed',
      output: [{ content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
      output_text: '',
      usage,
    });

    const err = await call(client).catch((e: AiJobError) => e);

    expect(err).toBeInstanceOf(AiJobError);
    expect((err as AiJobError).errorClass).toBe('TERMINAL');
  });

  it('parses a good response and bills it', async () => {
    const client = clientReturning({
      status: 'completed',
      output_text: '{"ok":true}',
      usage,
    });

    const out = await call(client);

    expect(out.data).toEqual({ ok: true });
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
  });
});

/**
 * Every call leaves a record of what it cost and what it was for.
 *
 * The totals kept per page and per import could say how much and nothing
 * else — and they dropped cached input and reasoning tokens entirely, so a
 * cost audit had nothing to read.
 */
describe('recording each call', () => {
  const config = {
    enabled: true,
    apiKey: 'test-key',
    model: 'gpt-6-luna',
    priceInPerMToken: 10,
    priceOutPerMToken: 50,
  } as unknown as AcademySiteConfig;

  const build = (create: jest.Mock) => {
    const log = { create: jest.fn().mockResolvedValue({}) };
    const client = new AiClient(config, { aiCallLog: log } as never);
    (client as unknown as { client: unknown }).client = { responses: { create } };
    return { client, log };
  };

  const call = (client: AiClient) =>
    client.completeStructured({
      model: 'gpt-6-sol',
      price: { inPerMToken: 200, outPerMToken: 1000 },
      reasoningEffort: 'medium',
      messages: [{ role: 'user', content: 'write questions' }],
      schemaName: 'thing',
      schema: { type: 'object' },
    });

  it('keeps cached input, reasoning tokens, the response id and the stage it was for', async () => {
    const { client, log } = build(
      jest.fn().mockResolvedValue({
        id: 'resp_123',
        status: 'completed',
        output_text: '{"ok":true}',
        usage: {
          input_tokens: 5000,
          input_tokens_details: { cached_tokens: 4000 },
          output_tokens: 3000,
          output_tokens_details: { reasoning_tokens: 2500 },
        },
      }),
    );

    await withAiTrace(
      { importId: 'imp1', phase: 'GENERATE', stage: 'QUESTION_GENERATION', batch: 2 },
      () => call(client),
    );

    expect(log.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        importId: 'imp1',
        phase: 'GENERATE',
        stage: 'QUESTION_GENERATION',
        batch: 2,
        model: 'gpt-6-sol',
        reasoningEffort: 'medium',
        status: 'ok',
        responseId: 'resp_123',
        inputTokens: 5000,
        cachedInputTokens: 4000,
        outputTokens: 3000,
        reasoningTokens: 2500,
        // 5000 × $2/M + 3000 × $10/M = 4¢ = 4000 millicents
        costMillicents: 4000,
      }),
    });
  });

  it('records a call that failed, with what the provider billed for it', async () => {
    const { client, log } = build(
      jest.fn().mockResolvedValue({
        id: 'resp_cut',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: '{"questions":[',
        usage: { input_tokens: 1000, output_tokens: 6000 },
      }),
    );

    await expect(call(client)).rejects.toThrow(/cut off/);
    expect(log.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'incomplete', outputTokens: 6000 }),
    });
  });

  it('never lets a failed write stop the call', async () => {
    const { client, log } = build(
      jest.fn().mockResolvedValue({ status: 'completed', output_text: '{}', usage: {} }),
    );
    log.create.mockRejectedValue(new Error('db down'));
    await expect(call(client)).resolves.toMatchObject({ data: {} });
  });
});

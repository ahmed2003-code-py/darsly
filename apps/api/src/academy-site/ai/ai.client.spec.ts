import { AcademySiteConfig } from '../academy-site.config';
import { AiClient } from './ai.client';
import { AiJobError } from './ai-job.error';

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

import { jobErrorCode } from './job-error-code';

/** What a teacher is shown for a failed generation: a code, never the provider's text. */
describe('a failed job, as a stable code', () => {
  it('reads the provider kind the shared client wrote', () => {
    expect(
      jobErrorCode(
        'OpenAI request failed (429) [ACCOUNT insufficient_quota]: You exceeded your current quota',
      ),
    ).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(jobErrorCode('OpenAI request failed (429) [RATE_LIMIT]: slow down')).toBe(
      'AI_PROVIDER_BUSY',
    );
    expect(jobErrorCode('OpenAI request failed [TIMEOUT]: Request timed out.')).toBe(
      'AI_PROVIDER_TIMEOUT',
    );
    expect(jobErrorCode('OpenAI request failed (503) [TRANSIENT]: upstream')).toBe(
      'AI_PROVIDER_ERROR',
    );
    expect(jobErrorCode('OpenAI request failed (400) [INVALID_REQUEST]: bad')).toBe(
      'AI_REQUEST_REFUSED',
    );
  });

  it('names the failures the pipeline itself raises', () => {
    expect(jobErrorCode('Not enough profile facts to generate a site')).toBe('SITE_FACTS_MISSING');
    expect(jobErrorCode('AI feature is disabled (AI_ACADEMY_ENABLED)')).toBe('AI_DISABLED');
    expect(jobErrorCode('AI response was cut off before it finished (max_output_tokens)')).toBe(
      'AI_OUTPUT_INVALID',
    );
    expect(jobErrorCode('AI output failed validation: x')).toBe('AI_OUTPUT_INVALID');
    expect(jobErrorCode('AI refused the request: no')).toBe('AI_REQUEST_REFUSED');
  });

  it('anything else is a generic failure; no error is no code', () => {
    expect(jobErrorCode('something nobody expected')).toBe('SITE_GENERATION_FAILED');
    expect(jobErrorCode(null)).toBeNull();
  });
});

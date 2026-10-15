import { providerFailureCode, type ProviderFailureKind } from '../ai/provider-failure';

/**
 * A failed job's stored error → the stable code a page shows.
 *
 * The Studio used to put the job's error string on screen — the provider's
 * own words, in English, inside an Arabic page ("OpenAI request failed
 * (429): You exceeded your current quota…"). The string stays on the job for
 * operators; a teacher gets one of these codes and the page says it in their
 * language. The provider kind is read from the marker the shared AI client
 * writes (`[ACCOUNT insufficient_quota]`, provider-failure.ts).
 */
export function jobErrorCode(error: string | null | undefined): string | null {
  if (!error) return null;
  const kind = /\[(ACCOUNT|RATE_LIMIT|TIMEOUT|TRANSIENT|INVALID_REQUEST|UNKNOWN)\b/.exec(
    error,
  )?.[1];
  if (kind) return providerFailureCode(kind as ProviderFailureKind);
  if (/feature is disabled|OPENAI_API_KEY is not configured/i.test(error)) return 'AI_DISABLED';
  if (/Not enough profile facts/i.test(error)) return 'SITE_FACTS_MISSING';
  if (/AI refused the request/i.test(error)) return 'AI_REQUEST_REFUSED';
  if (/cut off|not valid JSON|failed validation|empty output|document invalid/i.test(error))
    return 'AI_OUTPUT_INVALID';
  return 'SITE_GENERATION_FAILED';
}

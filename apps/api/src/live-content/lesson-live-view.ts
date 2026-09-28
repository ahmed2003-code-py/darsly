import { forViewers } from '../live/summary/grounded-summary';

/** What students (and the lesson page) are given from a lesson made from a Live class. */
export function lessonLiveView(liveContent: unknown) {
  const c = (liveContent ?? null) as {
    includeSummary?: boolean;
    includeTranscript?: boolean;
    summary?: unknown;
    transcriptSegments?: unknown[];
    transcriptPartial?: boolean;
  } | null;
  if (!c) return null;
  return {
    summary: c.includeSummary && c.summary ? forViewers(c.summary) : null,
    transcript: c.includeTranscript && Array.isArray(c.transcriptSegments) ? c.transcriptSegments : null,
    transcriptPartial: !!c.includeTranscript && !!c.transcriptPartial,
  };
}

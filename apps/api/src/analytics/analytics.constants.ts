/**
 * Thresholds shared across the analytics surface (and by NeedsAttentionService,
 * whose "inactive student" rule this centralizes) — named once so a future
 * change updates every consumer together instead of drifting between copies.
 */

/** Days without a recorded (tenant-scoped) GamificationEvent before an
 *  actively-enrolled student counts as inactive. */
export const INACTIVITY_DAYS = 14;

/** Growth/trend date ranges every analytics endpoint that takes a `range`
 *  query param accepts — same set AdminAnalyticsService already uses. */
export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export function isAnalyticsRange(v: unknown): v is AnalyticsRange {
  return typeof v === 'number' && (ANALYTICS_RANGES as readonly number[]).includes(v);
}

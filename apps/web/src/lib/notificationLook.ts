import type { TFunction } from 'i18next';

/**
 * How a notification presents itself.
 *
 * A list where every row is the same grey text in the same grey box makes the
 * reader do the sorting: a payment, a new message and a security alert all
 * arrive looking identical. An icon and a colour per kind lets someone scan the
 * list instead of reading it.
 */
const LOOK: Record<string, { icon: string; tone: string }> = {
  CHAT_MESSAGE: { icon: 'forum', tone: 'bg-primary-fixed text-primary' },
  ENROLLMENT_APPROVED: { icon: 'how_to_reg', tone: 'bg-secondary-container text-on-secondary-container' },
  NEW_LESSON: { icon: 'play_lesson', tone: 'bg-primary-fixed text-primary' },
  QUIZ_GRADED: { icon: 'grading', tone: 'bg-primary-fixed text-primary' },
  PAYOUT_STATUS: { icon: 'payments', tone: 'bg-secondary-container text-on-secondary-container' },
  SECURITY_ALERT: { icon: 'gpp_maybe', tone: 'bg-error-container text-on-error-container' },
  LIVE_SESSION_REMINDER: { icon: 'sensors', tone: 'bg-primary-fixed text-primary' },
  SUBSCRIPTION_RENEWAL: { icon: 'autorenew', tone: 'bg-primary-fixed text-primary' },
  ANNOUNCEMENT: { icon: 'campaign', tone: 'bg-surface-container-high text-on-surface-variant' },
};

/** Gamification announcements carry their own icon in `meta`. */
export function notificationLook(n: { type?: string; meta?: Record<string, unknown> | null }) {
  const metaIcon = n.meta && typeof n.meta.icon === 'string' ? (n.meta.icon as string) : null;
  const base = LOOK[n.type ?? ''] ?? LOOK.ANNOUNCEMENT;
  const kind = n.meta && typeof n.meta.kind === 'string' ? (n.meta.kind as string) : null;
  if (kind === 'level_up' || kind === 'streak' || kind === 'achievement') {
    return { icon: metaIcon ?? 'emoji_events', tone: 'bg-amber-100 text-amber-700' };
  }
  return { icon: metaIcon ?? base.icon, tone: base.tone };
}

/**
 * "منذ ٥ دقائق" rather than a calendar date.
 *
 * In a notification list the useful question is how long ago, not which day —
 * an absolute date makes the reader compute the answer themselves. Falls back
 * to the date once something is older than a week, where "منذ ١٤ يوم" stops
 * being easier to read than the date itself.
 */
export function timeAgo(iso: string | Date | null | undefined, t: TFunction, locale: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return t('time.justNow');
  const mins = Math.round(secs / 60);
  if (mins < 60) return t('time.minutes', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t('time.days', { count: days });
  return new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'ar-EG', {
    day: 'numeric',
    month: 'short',
  });
}

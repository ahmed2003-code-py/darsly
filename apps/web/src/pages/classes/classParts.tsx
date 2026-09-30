import { useTranslation } from 'react-i18next';
import type { AttendanceStatus, ClassStatus } from '../../lib/classOps';

/**
 * Shared pieces of the class screens (Center Operations C2). Every
 * attendance state is drawn as icon + words + its colour, never colour alone,
 * so a teacher reading a phone in sunlight, or someone who cannot tell red
 * from green, sees the same thing.
 */

export const STATUS_ICON: Record<AttendanceStatus, string> = {
  PRESENT: 'check_circle',
  LATE: 'schedule',
  ABSENT: 'cancel',
  EXCUSED: 'event_busy',
};

/** Tinted text for a status line (literal strings — Tailwind's scanner reads them). */
export const STATUS_TEXT: Record<AttendanceStatus, string> = {
  PRESENT: 'text-primary',
  LATE: 'text-amber-700 dark:text-amber-400',
  ABSENT: 'text-error',
  EXCUSED: 'text-on-surface-variant',
};

/** A pressed status button. */
export const STATUS_PRESSED: Record<AttendanceStatus, string> = {
  PRESENT: 'bg-primary text-on-primary border-primary',
  LATE: 'bg-amber-500 text-white border-amber-500',
  ABSENT: 'bg-error text-on-error border-error',
  EXCUSED: 'bg-on-surface-variant text-surface border-on-surface-variant',
};

export function StatusLabel({
  status,
  auto,
  time,
}: {
  status: AttendanceStatus | null;
  auto?: boolean;
  time?: string | null;
}) {
  const { t } = useTranslation();
  if (!status)
    return (
      <span className="inline-flex items-center gap-1 text-on-surface-variant">
        <span className="material-symbols-outlined text-base" aria-hidden>
          radio_button_unchecked
        </span>
        {t('classes.status.UNMARKED')}
      </span>
    );
  return (
    <span className={`inline-flex items-center gap-1 font-semibold ${STATUS_TEXT[status]}`}>
      <span className="material-symbols-outlined text-base" aria-hidden>
        {STATUS_ICON[status]}
      </span>
      {t(`classes.status.${status}`)}
      {auto && <span className="font-normal text-outline">· {t('classes.auto')}</span>}
      {time && (
        <span className="font-normal tabular-nums text-outline" dir="ltr">
          {time}
        </span>
      )}
    </span>
  );
}

/** Where a class stands, as one chip. */
export function ClassStateChip({
  status,
  startedAt,
  closedAt,
  live,
}: {
  status: ClassStatus;
  startedAt: string | null;
  closedAt: string | null;
  live: boolean;
}) {
  const { t } = useTranslation();
  const [icon, label, tone] =
    status === 'CANCELLED'
      ? ['block', t('classes.state.cancelled'), 'bg-error-container text-on-error-container']
      : closedAt
        ? [
            'task_alt',
            t('classes.state.closed'),
            'bg-surface-container-high text-on-surface-variant',
          ]
        : startedAt || live
          ? [
              'play_circle',
              t('classes.state.live'),
              'bg-primary-fixed text-on-primary-fixed-variant',
            ]
          : [
              'schedule',
              t('classes.state.upcoming'),
              'bg-surface-container-high text-on-surface-variant',
            ];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${tone}`}
    >
      <span className="material-symbols-outlined text-sm" aria-hidden>
        {icon}
      </span>
      {label}
    </span>
  );
}

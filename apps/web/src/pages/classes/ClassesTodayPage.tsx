import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorNote, PageHeader, Skeleton, Spinner } from '../../components/ui';
import {
  ClassSummary,
  formatClock,
  formatLocalDate,
  shiftDate,
  useClassAccess,
  useClassDay,
} from '../../lib/classOps';
import { ClassStateChip } from './classParts';

/**
 * Today's classes (Center Operations C2): what is on, where, with whom, and
 * how attendance stands — the one screen a desk or a teacher opens first.
 * An owner sees every class; a teacher or assistant only their groups' (the
 * server scopes it). A day switcher steps back to take a missed sheet or
 * ahead to see tomorrow; each card opens the class.
 */
export default function ClassesTodayPage() {
  const { t, i18n } = useTranslation();
  const access = useClassAccess();
  const [date, setDate] = useState<string | undefined>(undefined);
  const day = useClassDay(date, !!access.data?.canAttend);

  if (access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!access.data?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('classes.off')} hint={t('classes.offHint')} />
      </div>
    );
  if (!access.data.canAttend)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('classes.noAccess')} hint={t('classes.noAccessHint')} />
      </div>
    );

  const shown = day.data?.date ?? access.data.today ?? '';
  const isToday = shown === (day.data?.today ?? access.data.today);
  const classes = day.data?.classes ?? [];
  const nowMs = Date.now();

  return (
    <div className="page">
      <PageHeader
        title={isToday ? t('classes.todayTitle') : formatLocalDate(shown, i18n.language)}
        subtitle={isToday ? formatLocalDate(shown, i18n.language) : t('classes.otherDay')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1">
          <button
            type="button"
            aria-label={t('classes.prevDay')}
            className="grid h-11 w-11 place-items-center rounded-lg hover:bg-surface-container-low"
            onClick={() => setDate(shiftDate(shown, -1))}
          >
            <span className="material-symbols-outlined rtl:rotate-180" aria-hidden>
              chevron_left
            </span>
          </button>
          <span className="min-w-[7.5rem] px-1 text-center text-sm font-semibold">
            {formatLocalDate(shown, i18n.language, { weekday: 'short' })}
          </span>
          <button
            type="button"
            aria-label={t('classes.nextDay')}
            className="grid h-11 w-11 place-items-center rounded-lg hover:bg-surface-container-low"
            onClick={() => setDate(shiftDate(shown, 1))}
          >
            <span className="material-symbols-outlined rtl:rotate-180" aria-hidden>
              chevron_right
            </span>
          </button>
        </div>
        {!isToday && (
          <button className="btn-secondary min-h-11 px-4" onClick={() => setDate(undefined)}>
            {t('classes.backToToday')}
          </button>
        )}
      </div>

      <ErrorNote error={day.error} />
      {day.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
        </div>
      ) : !classes.length ? (
        <EmptyState
          icon="event_available"
          title={isToday ? t('classes.noneToday') : t('classes.noneThatDay')}
          hint={access.data.canSchedule ? t('classes.noneHintPlan') : t('classes.noneHint')}
        />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {classes.map((c) => (
            <ClassCard key={c.id} c={c} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function ClassCard({ c, nowMs }: { c: ClassSummary; nowMs: number }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const live = nowMs >= new Date(c.startAt).getTime() && nowMs < new Date(c.endAt).getTime();
  const came = c.counts.present + c.counts.late;
  const cancelled = c.status === 'CANCELLED';
  return (
    <li>
      <Link
        to={`/classes/${c.id}`}
        className={`card-hover block rounded-2xl border bg-surface-container-lowest p-4 ${
          live && !cancelled ? 'border-primary' : 'border-outline-variant'
        } ${cancelled ? 'opacity-70' : ''}`}
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 text-center">
            <p className="font-heading text-lg font-extrabold tabular-nums leading-tight">
              {formatClock(c.startTime, lang)}
            </p>
            <p className="text-xs tabular-nums text-outline">{formatClock(c.endTime, lang)}</p>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-heading font-bold leading-snug [overflow-wrap:anywhere]">
                <bdi>{c.group.name}</bdi>
              </p>
              <ClassStateChip
                status={c.status}
                startedAt={c.startedAt}
                closedAt={c.closedAt}
                live={live}
              />
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-on-surface-variant">
              {c.room && (
                <span className="inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-base" aria-hidden>
                    meeting_room
                  </span>
                  <bdi>{c.room.name}</bdi>
                </span>
              )}
              {c.teacher && (
                <span className="inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-base" aria-hidden>
                    person
                  </span>
                  <bdi>{c.teacher.fullName}</bdi>
                </span>
              )}
            </p>
            {!cancelled && (
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <span>
                  <span className="font-bold tabular-nums">{came}</span>{' '}
                  <span className="text-on-surface-variant">
                    {t('classes.cameOf', { count: c.counts.expected })}
                  </span>
                </span>
                {c.counts.late > 0 && (
                  <span className="text-amber-700 dark:text-amber-400">
                    {t('classes.lateCount', { count: c.counts.late })}
                  </span>
                )}
                {c.counts.absent > 0 && (
                  <span className="text-error">
                    {t('classes.absentCount', { count: c.counts.absent })}
                  </span>
                )}
                {c.counts.makeup > 0 && (
                  <span className="text-on-surface-variant">
                    {t('classes.makeupCount', { count: c.counts.makeup })}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

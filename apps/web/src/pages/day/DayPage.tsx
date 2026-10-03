import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorNote, Modal, Skeleton, Spinner } from '../../components/ui';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import { formatInstant, shiftDate } from '../../lib/classOps';
import {
  DayException,
  DayFigures,
  DayView,
  useCloseDay,
  useDailyAccess,
  useDay,
} from '../../lib/dailyOps';
import { isNetworkFailure } from '../../lib/desk';
import { newRequestKey } from '../../lib/paperExams';
import { dayLabel, Money } from '../fees/feeParts';

/**
 * The day at the center (C7): what happened (facts, from the day's records),
 * what is still open (tasks), and the day's close — a frozen, versioned
 * snapshot. Nothing on this page changes attendance or money, and an open day
 * blocks nobody.
 */
export default function DayPage() {
  const { t, i18n } = useTranslation();
  const academyId = useRegistryAcademyId();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? undefined;
  const access = useDailyAccess(academyId);
  const day = useDay(academyId, date, !!access.data?.canView);
  const [closing, setClosing] = useState(false);
  const [asClosed, setAsClosed] = useState(false);
  const a = access.data;
  if (!academyId || access.isLoading)
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!a?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('day.off')} hint={t('day.offHint')} />
      </div>
    );
  if (!a.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('day.noAccess')} hint={t('day.noAccessHint')} />
      </div>
    );
  const d = day.data;
  const go = (to: string | null) => {
    setAsClosed(false);
    const next = new URLSearchParams(params);
    if (to) next.set('date', to);
    else next.delete('date');
    setParams(next, { replace: true });
  };
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const shown: DayFigures | undefined = d && (asClosed && d.latest ? d.latest.figures : d.figures);
  return (
    <div className="page max-w-5xl">
      <h1 className="mb-1 font-heading text-2xl font-extrabold sm:text-3xl">{t('day.title')}</h1>
      <p className="mb-4 text-sm text-on-surface-variant">{t('day.sub')}</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-outline-variant bg-surface-container-lowest p-1">
          <button
            type="button"
            aria-label={t('day.prev')}
            className="grid h-11 w-11 place-items-center rounded-lg hover:bg-surface-container-low"
            disabled={!d}
            onClick={() => d && go(shiftDate(d.date, -1))}
          >
            <span className="material-symbols-outlined rtl:rotate-180" aria-hidden>
              chevron_left
            </span>
          </button>
          <input
            type="date"
            aria-label={t('day.pick')}
            className="input min-h-11 w-auto border-0"
            value={d?.date ?? ''}
            max={d?.today}
            onChange={(e) => e.target.value && go(e.target.value)}
          />
          <button
            type="button"
            aria-label={t('day.next')}
            className="grid h-11 w-11 place-items-center rounded-lg hover:bg-surface-container-low"
            disabled={!d || d.date >= d.today}
            onClick={() => d && go(shiftDate(d.date, 1))}
          >
            <span className="material-symbols-outlined rtl:rotate-180" aria-hidden>
              chevron_right
            </span>
          </button>
        </div>
        {d && d.date !== d.today && (
          <button type="button" className="btn-ghost min-h-11 px-4" onClick={() => go(null)}>
            {t('day.toToday')}
          </button>
        )}
        {d && a.canClose && d.date <= d.today && (
          <button
            type="button"
            className="btn-primary min-h-11 px-5 sm:ms-auto"
            onClick={() => setClosing(true)}
          >
            {d.latest ? t('day.closeAgain') : t('day.close')}
          </button>
        )}
      </div>

      {day.error ? (
        <ErrorNote error={day.error} />
      ) : !d || !shown ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <>
          <StatusBanner d={d} asClosed={asClosed} setAsClosed={setAsClosed} lang={lang} />
          <Attention d={d} lang={lang} />
          <Figures f={shown} />
          <ClassList d={d} lang={lang} academyId={academyId} />
          <History d={d} lang={lang} />
        </>
      )}
      {closing && d && (
        <CloseDialog academyId={academyId} d={d} onClose={() => setClosing(false)} />
      )}
    </div>
  );
}

function StatusBanner({
  d,
  asClosed,
  setAsClosed,
  lang,
}: {
  d: DayView;
  asClosed: boolean;
  setAsClosed: (v: boolean) => void;
  lang: string;
}) {
  const { t } = useTranslation();
  const last = d.closes.at(-1);
  return (
    <section className="card mb-4 p-4" aria-live="polite">
      <p className="font-semibold">
        {dayLabel(d.date, lang)}
        {' · '}
        {last
          ? t('day.closedAt', {
              version: last.version,
              time: formatInstant(last.closedAt, d.timezone, lang),
              name: last.closedBy,
            })
          : d.date < d.today
            ? t('day.notClosed')
            : t('day.inProgress')}
      </p>
      {d.latest && d.latest.drift.length > 0 && (
        <p className="mt-2 rounded-xl bg-amber-500/10 p-2 text-sm" role="status">
          {t('day.drift', {
            sections: d.latest.drift.map((s) => t(`day.section.${s}`)).join('، '),
          })}
        </p>
      )}
      {d.latest && (
        <div
          className="mt-3 inline-flex rounded-xl border border-outline-variant p-1"
          role="radiogroup"
          aria-label={t('day.showing')}
        >
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={asClosed === v}
              onClick={() => setAsClosed(v)}
              className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${asClosed === v ? 'bg-primary-fixed/50' : ''}`}
            >
              {v ? t('day.asClosed', { version: d.latest!.version }) : t('day.live')}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Open items: what keeps the day from a clean close, and tasks still waiting. */
function Attention({ d, lang }: { d: DayView; lang: string }) {
  const { t } = useTranslation();
  const drafts = d.figures.exams?.state.draftsDue ?? 0;
  const cases = d.figures.followUp?.state.openCases ?? 0;
  if (!d.exceptions.length && !drafts && !cases) return null;
  return (
    <section className="card mb-4 p-4">
      <h2 className="mb-2 font-heading text-lg font-bold">{t('day.attention')}</h2>
      <ul className="space-y-1 text-sm">
        {d.exceptions.map((x) => (
          <li key={`${x.code}-${x.sessionId}`}>
            <Link
              className="flex min-h-11 items-center gap-2 font-semibold text-primary"
              to={`/classes/${x.sessionId}`}
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                {x.code === 'CLASS_NOT_ENDED' ? 'schedule' : 'fact_check'}
              </span>
              <ExceptionText x={x} tz={d.timezone} lang={lang} />
            </Link>
          </li>
        ))}
        {drafts > 0 && (
          <li>
            <Link
              className="flex min-h-11 items-center gap-2 font-semibold text-primary"
              to="/center/exams"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                grading
              </span>
              {t('day.task.drafts', { count: drafts })}
            </Link>
          </li>
        )}
        {cases > 0 && (
          <li>
            <Link
              className="flex min-h-11 items-center gap-2 font-semibold text-primary"
              to="/center/follow-up"
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                support_agent
              </span>
              {t('day.task.cases', { count: cases })}
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}

function ExceptionText({ x, tz, lang }: { x: DayException; tz: string; lang: string }) {
  const { t } = useTranslation();
  const time = formatInstant(x.startAt, tz, lang);
  return x.code === 'CLASS_NOT_ENDED' ? (
    <>{t('day.exc.notEnded', { group: x.groupName, time })}</>
  ) : (
    <>{t('day.exc.notClosed', { group: x.groupName, time, count: x.unmarked })}</>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-container-low p-3">
      <p className="text-xs text-on-surface-variant">{label}</p>
      <p className="font-extrabold tabular-nums">
        <bdi dir="ltr">{value}</bdi>
      </p>
    </div>
  );
}

function Section({
  title,
  to,
  children,
}: {
  title: string;
  to?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold">{title}</h2>
        {to && (
          <Link
            to={to}
            className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-sm font-semibold text-primary"
          >
            {t('day.open')}
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
    </section>
  );
}

function Figures({ f }: { f: DayFigures }) {
  const { t } = useTranslation();
  const c = f.collections;
  return (
    <div className="mb-4 grid gap-4 md:grid-cols-2">
      <Section title={t('day.section.classes')} to="/classes">
        <Stat label={t('day.f.total')} value={f.classes.total} />
        <Stat label={t('day.f.completed')} value={f.classes.completed} />
        <Stat label={t('day.f.cancelled')} value={f.classes.cancelled} />
        <Stat label={t('day.f.upcoming')} value={f.classes.upcoming} />
      </Section>
      <Section title={t('day.section.attendance')}>
        <Stat label={t('day.f.present')} value={f.attendance.present} />
        <Stat label={t('day.f.late')} value={f.attendance.late} />
        <Stat label={t('day.f.absent')} value={f.attendance.absent} />
        <Stat label={t('day.f.excused')} value={f.attendance.excused} />
        <Stat label={t('day.f.unmarked')} value={f.attendance.unmarked} />
        <Stat
          label={t('day.f.closedClasses')}
          value={`${f.attendance.closedClasses} / ${f.attendance.closedClasses + f.attendance.openClasses}`}
        />
      </Section>
      {f.desk && (
        <Section title={t('day.section.desk')} to="/desk">
          <Stat label={t('day.f.checkIns')} value={f.desk.checkIns} />
          <Stat label={t('day.f.byCard')} value={f.desk.byCard} />
          <Stat label={t('day.f.byCode')} value={f.desk.byCode} />
        </Section>
      )}
      {c && (
        <Section title={t('day.section.collections')} to="/center/fees">
          <Stat
            label={t('day.f.received', { count: c.received.count })}
            value={<Money cents={c.received.amountCents} currency={c.currency} />}
          />
          <Stat
            label={t('day.f.reversedToday', { count: c.reversedToday.count })}
            value={<Money cents={c.reversedToday.amountCents} currency={c.currency} />}
          />
          <Stat label={t('day.f.net')} value={<Money cents={c.netCents} currency={c.currency} />} />
          {Object.entries(c.received.byMethod)
            .filter(([, m]) => m.count > 0)
            .map(([k, m]) => (
              <Stat
                key={k}
                label={t(`fees.method.${k}`)}
                value={<Money cents={m.amountCents} currency={c.currency} />}
              />
            ))}
        </Section>
      )}
      {f.followUp && (
        <Section title={t('day.section.followUp')} to="/center/follow-up">
          <Stat label={t('day.f.opened')} value={f.followUp.opened} />
          <Stat label={t('day.f.resolved')} value={f.followUp.resolved + f.followUp.dismissed} />
          <Stat label={t('day.f.contacts')} value={f.followUp.contacts} />
        </Section>
      )}
      {f.exams && (
        <Section title={t('day.section.exams')} to="/center/exams">
          <Stat label={t('day.f.published')} value={f.exams.published} />
          <Stat label={t('day.f.corrections')} value={f.exams.corrections} />
        </Section>
      )}
    </div>
  );
}

function ClassList({ d, lang, academyId }: { d: DayView; lang: string; academyId: string }) {
  const { t } = useTranslation();
  if (!d.classes.length)
    return (
      <section className="card mb-4 p-4">
        <p className="text-sm text-on-surface-variant">{t('day.noClasses')}</p>
      </section>
    );
  return (
    <section className="card mb-4 p-4">
      <h2 className="mb-2 font-heading text-lg font-bold">{t('day.section.classList')}</h2>
      <ul className="divide-y divide-outline-variant/40">
        {d.classes.map((c) => (
          <li key={c.id}>
            <Link
              to={`/classes/${c.id}?academy=${academyId}`}
              className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <span className="w-20 shrink-0 tabular-nums text-sm font-semibold" dir="ltr">
                {formatInstant(c.startAt, d.timezone, lang)}
              </span>
              <span className="min-w-0 flex-1 basis-40 truncate font-semibold">{c.groupName}</span>
              <span className="text-xs text-on-surface-variant">
                {c.status === 'CANCELLED'
                  ? t('day.cls.cancelled')
                  : t('day.cls.counts', { present: c.present + c.late, expected: c.expected })}
              </span>
              {c.status !== 'CANCELLED' && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    c.attendanceClosed
                      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                      : 'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                  }`}
                >
                  {c.attendanceClosed ? t('day.cls.closed') : t('day.cls.open')}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ d, lang }: { d: DayView; lang: string }) {
  const { t } = useTranslation();
  if (!d.closes.length) return null;
  return (
    <section className="card mb-4 p-4">
      <h2 className="mb-2 font-heading text-lg font-bold">{t('day.history')}</h2>
      <ul className="space-y-2 text-sm">
        {[...d.closes].reverse().map((c) => (
          <li key={c.version} className="rounded-xl bg-surface-container-low p-3">
            <p className="font-semibold">
              {t('day.version', { version: c.version })} ·{' '}
              {formatInstant(c.closedAt, d.timezone, lang)} · {c.closedBy}
            </p>
            {c.reason && (
              <p className="text-on-surface-variant">{t('day.reasonWas', { reason: c.reason })}</p>
            )}
            {c.exceptions > 0 && (
              <p className="text-on-surface-variant">
                {t('day.closedWith', { count: c.exceptions })}
                {c.exceptionNote ? ` — ${c.exceptionNote}` : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CloseDialog({
  academyId,
  d,
  onClose,
}: {
  academyId: string;
  d: DayView;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'ar';
  const act = useCloseDay(academyId);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  // One identity for this close: a retry or a double click is one close.
  const [requestKey] = useState(newRequestKey);
  const again = d.closes.length > 0;
  const needNote = d.exceptions.length > 0;
  const ok = (!needNote || note.trim().length >= 3) && (!again || reason.trim().length >= 3);
  const pending = act.isPending;
  return (
    <Modal
      open
      title={
        again
          ? t('day.closeAgainTitle', { date: dayLabel(d.date, lang) })
          : t('day.closeTitle', { date: dayLabel(d.date, lang) })
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          act.mutate(
            {
              date: d.date,
              requestKey,
              ...(needNote ? { exceptionNote: note.trim() } : {}),
              ...(again ? { reason: reason.trim() } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">{t('day.closeBody')}</p>
        {needNote && (
          <>
            <ul className="mb-2 space-y-1 rounded-xl bg-amber-500/10 p-3 text-sm">
              {d.exceptions.map((x) => (
                <li key={`${x.code}-${x.sessionId}`}>
                  <ExceptionText x={x} tz={d.timezone} lang={lang} />
                </li>
              ))}
            </ul>
            <label className="mb-3 block">
              <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                {t('day.note')}
              </span>
              <textarea
                className="input min-h-20"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                required
              />
              <span className="mt-1 block text-xs text-on-surface-variant">
                {t('day.noteHint')}
              </span>
            </label>
          </>
        )}
        {again && (
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('day.reason')}
            </span>
            <textarea
              className="input min-h-20"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              required
            />
            <span className="mt-1 block text-xs text-on-surface-variant">
              {t('day.reasonHint')}
            </span>
          </label>
        )}
        {act.error != null &&
          (isNetworkFailure(act.error) ? (
            <p className="mt-3 text-sm text-error" role="alert">
              {t('day.offline')}
            </p>
          ) : (
            <ErrorNote error={act.error} />
          ))}
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {again ? t('day.closeAgain') : t('day.close')}
        </button>
      </form>
    </Modal>
  );
}

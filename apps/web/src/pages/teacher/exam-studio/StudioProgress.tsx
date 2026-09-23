import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ProgressBar } from '../../../components/ui';
import {
  CREATION_STEPS,
  CreationState,
  PaperImport,
  creationState,
  livePage,
  stepStates,
} from '../../../lib/paperImport';

/**
 * What the system is doing, said out loud.
 *
 * Every number here is the worker's own — pages it has finished reading,
 * questions it has finished writing — read from the session row it updates as
 * it goes. Nothing is interpolated and nothing moves on a timer, which is the
 * whole point: a bar that crawls from 0 to 100 while the backend does nothing
 * is a lie that costs a teacher their trust the first time it finishes and the
 * page does not change.
 *
 * Where the work genuinely cannot be counted, the bar says so by being
 * indeterminate and the stage text carries the meaning instead. That is the
 * honest version of "we are still working".
 */
export function StudioProgress({
  record,
  onCancel,
  canceling,
}: {
  record: PaperImport;
  onCancel?: () => void;
  canceling?: boolean;
}) {
  const { t } = useTranslation();
  const state = creationState(record);
  const steps = stepStates(record);
  const active = CREATION_STEPS.find((step) => steps[step] === 'active');
  const live = livePage(record);
  const { done, total } = record.progress;
  const measurable = total > 0;
  const pct = measurable ? Math.round((done / total) * 100) : 0;

  return (
    <div className="card">
      {/*
        The whole road, at the top, before anything else: the steps behind it
        (green, ticked), the one it is on, and the ones still to come. A
        teacher should know how far along their exam is at a glance.
      */}
      <Stepper steps={steps} kind={record.kind} />

      <div className="mb-4 mt-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-lg font-semibold text-on-surface">
            {t(`examStudio.state.${state}`)}
          </p>
          <p className="mt-1 text-sm text-on-surface-variant">{unitLine(record, t)}</p>
        </div>
        <Elapsed />
      </div>

      {measurable ? (
        <>
          <ProgressBar pct={pct} />
          <p className="mt-2 text-sm font-semibold text-on-surface-variant" dir="ltr">
            {done} / {total}
          </p>
        </>
      ) : (
        // No countable units yet. An indeterminate bar and a sentence that
        // says what is happening beats a number nobody can justify.
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
          <div className="h-full w-1/3 animate-[studio-sweep_1.4s_ease-in-out_infinite] rounded-full bg-primary" />
        </div>
      )}

      {/*
        What is being done to which page, this second — the worker's own
        report, written as each step starts, not an animation. A page can take
        a minute, and "re-reading the unclear parts, 3 of 8" is the difference
        between waiting and wondering whether anything is happening at all.
        Between pages, the step being worked on says what it does instead.
      */}
      {live ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-primary/5 px-3 py-2 text-sm text-on-surface">
          <span className="material-symbols-outlined mt-px animate-pulse text-base text-primary">
            motion_photos_on
          </span>
          <span className="min-w-0">
            {record.pages.length > 1 && (
              <span className="font-semibold">
                {t('examStudio.livePage', { page: live.pageNumber, total: record.pages.length })}
                {' — '}
              </span>
            )}
            {t(`examStudio.phase.${live.phase}`, {
              done: Math.min(live.done + 1, live.total),
              total: live.total,
            })}
          </span>
        </p>
      ) : (
        active && (
          <p className="mt-4 text-sm text-on-surface-variant">
            {t(`examStudio.stepWhat.${active}`, { context: record.kind })}
          </p>
        )
      )}

      {/* The one thing somebody watching this most needs to be told. */}
      <p className="mt-4 flex items-start gap-2 text-xs text-outline">
        <span className="material-symbols-outlined text-sm">info</span>
        <span>
          {t('examStudio.leaveHint')}{' '}
          <Link to="/teacher/courses" className="font-semibold text-primary underline">
            {t('examStudio.leaveHintLink')}
          </Link>
        </span>
      </p>

      {record.pages.length > 1 && <PageDetail record={record} />}

      {onCancel && (
        <button className="btn-ghost mt-4 px-2" disabled={canceling} onClick={onCancel}>
          {t('examStudio.cancel')}
        </button>
      )}
    </div>
  );
}

/**
 * The steps as a row of dots that turn green one at a time.
 *
 * Read from `stepStates`, which reads the server's own `stage`: a green dot
 * means the worker finished that step, never that a timer ran out.
 */
function Stepper({
  steps,
  kind,
}: {
  steps: ReturnType<typeof stepStates>;
  kind: PaperImport['kind'];
}) {
  const { t } = useTranslation();
  return (
    <ol className="flex items-start">
      {CREATION_STEPS.map((step, i) => {
        const s = steps[step];
        const last = i === CREATION_STEPS.length - 1;
        return (
          <li key={step} className="relative flex min-w-0 flex-1 flex-col items-center text-center">
            {/* The line to the next dot — green once this step is behind us.
                Logical `start`, so it runs the right way in Arabic and English. */}
            {!last && (
              <span
                aria-hidden="true"
                className={`absolute top-4 h-0.5 w-full transition-colors duration-500 ${
                  s === 'done' ? 'bg-emerald-500' : 'bg-outline-variant/60'
                }`}
                style={{ insetInlineStart: '50%' }}
              />
            )}
            <span
              className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border-2 transition-colors duration-500 ${
                s === 'done'
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : s === 'active'
                    ? 'border-primary bg-surface-container-lowest text-primary ring-4 ring-primary/15'
                    : 'border-outline-variant bg-surface-container-lowest text-outline'
              }`}
              aria-current={s === 'active' ? 'step' : undefined}
            >
              {s === 'done' ? (
                <span className="material-symbols-outlined text-lg">check</span>
              ) : s === 'active' ? (
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
              ) : (
                <span className="text-xs font-bold" dir="ltr">
                  {i + 1}
                </span>
              )}
            </span>
            <span
              className={`mt-2 px-1 text-[11px] leading-tight sm:text-xs ${
                s === 'done'
                  ? 'font-semibold text-emerald-700 dark:text-emerald-400'
                  : s === 'active'
                    ? 'font-semibold text-on-surface'
                    : 'text-outline'
              }`}
            >
              {t(`examStudio.step.${step}`, { context: kind })}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The per-page breakdown, folded away. Useful when something is stuck on one
 *  page, noise the rest of the time — so it is there and closed. */
function PageDetail({ record }: { record: PaperImport }) {
  const { t } = useTranslation();
  return (
    <details className="mt-4 rounded-xl bg-surface-container-low p-3">
      <summary className="cursor-pointer text-sm font-semibold text-on-surface-variant">
        {t('examStudio.pageDetail')}
      </summary>
      <ul className="mt-3 space-y-1">
        {record.pages.map((page) => (
          <li key={page.id} className="flex items-center gap-2 text-sm">
            <span
              className={`material-symbols-outlined text-base ${
                page.status === 'FAILED'
                  ? 'text-error'
                  : page.status === 'PENDING'
                    ? 'text-outline-variant'
                    : 'text-primary'
              }`}
            >
              {page.status === 'FAILED'
                ? 'error'
                : page.phase
                  ? 'motion_photos_on'
                  : page.status === 'PENDING'
                    ? 'schedule'
                    : 'check'}
            </span>
            <span className="text-on-surface">{t('paper.page', { n: page.pageNumber })}</span>
            <span className="text-outline">
              —{' '}
              {page.phase
                ? t(`examStudio.phase.${page.phase}`, {
                    done: Math.min((page.phaseDone ?? 0) + 1, page.phaseTotal ?? 0),
                    total: page.phaseTotal ?? 0,
                  })
                : t(`examStudio.pageStatus.${page.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** How long this has been running. Only shown once it is long enough to be
 *  worth knowing — a counter that starts at zero on every screen is noise. */
function Elapsed() {
  const { t } = useTranslation();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (seconds < 15) return null;
  const mins = Math.floor(seconds / 60);
  return (
    <span className="shrink-0 text-sm text-outline" dir="ltr">
      {mins ? t('examStudio.elapsedMin', { n: mins }) : t('examStudio.elapsedSec', { n: seconds })}
    </span>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function unitLine(record: PaperImport, t: Translate): string {
  if (record.stage === 'GENERATING') {
    return t('examStudio.unitQuestions', {
      done: record.progress.done,
      total: record.progress.total,
    });
  }
  if (record.progress.total) {
    return t('examStudio.unitPages', { done: record.progress.done, total: record.progress.total });
  }
  return t('examStudio.unitStarting');
}

export { creationState };
export type { CreationState };

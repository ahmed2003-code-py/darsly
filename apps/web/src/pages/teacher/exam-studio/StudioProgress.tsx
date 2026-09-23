import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProgressBar } from '../../../components/ui';
import {
  CREATION_STEPS,
  CreationState,
  PaperImport,
  creationState,
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
  const { done, total } = record.progress;
  const measurable = total > 0;
  const pct = measurable ? Math.round((done / total) * 100) : 0;

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
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
        What each step is, not only that it exists.
        
        A list of five nouns tells a teacher that five things happen and
        nothing about what any of them is — so a four-minute wait on "استخراج
        الأسئلة" reads as a machine that has stopped. The sentence under the
        step being worked on says what is happening to their pages right now;
        finished steps keep theirs, folded down, so the screen also answers
        "what has already been done to my paper".
      */}
      <ol className="mt-6 space-y-3">
        {CREATION_STEPS.map((step) => (
          <li key={step} className="flex items-start gap-2 text-sm">
            <span
              className={`material-symbols-outlined mt-0.5 text-base ${
                steps[step] === 'done'
                  ? 'text-primary'
                  : steps[step] === 'active'
                    ? 'text-on-surface'
                    : 'text-outline-variant'
              }`}
            >
              {steps[step] === 'done'
                ? 'check_circle'
                : steps[step] === 'active'
                  ? 'radio_button_checked'
                  : 'radio_button_unchecked'}
            </span>
            <div className="min-w-0">
              <p
                className={
                  steps[step] === 'todo' ? 'text-outline' : 'font-semibold text-on-surface'
                }
              >
                {t(`examStudio.step.${step}`, { context: record.kind })}
              </p>
              {/* Not on the steps still to come: describing work that has not
                  started is noise on a screen somebody is watching. */}
              {steps[step] !== 'todo' && (
                <p
                  className={`mt-0.5 text-xs ${
                    steps[step] === 'active' ? 'text-on-surface-variant' : 'text-outline'
                  }`}
                >
                  {t(`examStudio.stepWhat.${step}`, { context: record.kind })}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {record.pages.length > 1 && <PageDetail record={record} />}

      {onCancel && (
        <button className="btn-ghost mt-4 px-2" disabled={canceling} onClick={onCancel}>
          {t('examStudio.cancel')}
        </button>
      )}
    </div>
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
                : page.status === 'PENDING'
                  ? 'schedule'
                  : 'check'}
            </span>
            <span className="text-on-surface">{t('paper.page', { n: page.pageNumber })}</span>
            <span className="text-outline">— {t(`examStudio.pageStatus.${page.status}`)}</span>
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

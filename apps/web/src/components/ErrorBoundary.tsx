import { Component, ErrorInfo, ReactNode } from 'react';
import i18n from '../i18n';

/**
 * Render crashes, contained.
 *
 * Two boundaries, two jobs:
 *
 *  - `ErrorBoundary` (default export) wraps the whole app. It catches what
 *    nothing below caught, and it owns the one crash that fixes itself: a
 *    dynamic chunk that a new deploy deleted while a tab held the old
 *    index.html. That one reloads once to pull the fresh build; anything else
 *    shows a recoverable screen instead of a white one.
 *
 *  - `SectionErrorBoundary` wraps each page inside the shell (Layout), reset
 *    by route. A bug in one page used to blank the whole app, navigation
 *    included; now the page says it could not load and the sidebar, top bar
 *    and every other page keep working. Moving to another route resets it.
 *    It never swallows a chunk error — those go up to the root, which knows
 *    how to recover from them.
 *
 * Neither hides a bug: both log the error and its component stack.
 */

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  /** A reload is already on its way, so there is nothing to say. */
  recovering: boolean;
}

const dir = () => (i18n.language === 'en' ? 'ltr' : 'rtl');

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false };

  static getDerivedStateFromError(error: Error): State {
    // Deciding here rather than in componentDidCatch is the difference between
    // a student seeing "something went wrong" and seeing nothing at all: this
    // runs before the first paint, componentDidCatch runs after it.
    return { error, recovering: isRecoverable(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Production React logs only the error; where it happened is what makes
    // a crash report actionable.
    console.error('[ErrorBoundary]', error?.stack ?? error, info.componentStack);
    if (isRecoverable(error)) {
      // Reload once (guarded so we never loop) to fetch the current build.
      sessionStorage.setItem('chunk-reloaded', '1');
      window.location.reload();
    }
  }

  render() {
    // The page is already reloading. Showing an error for the half-second
    // before it lands tells the student something broke when nothing did.
    if (this.state.recovering) {
      return <div className="grid min-h-screen place-items-center bg-surface" />;
    }
    if (this.state.error) {
      return (
        <div
          dir={dir()}
          className="grid min-h-screen place-items-center bg-surface p-6 text-center text-on-surface"
        >
          <div className="max-w-sm space-y-4" role="alert">
            <span
              aria-hidden
              className="material-symbols-outlined text-[44px] text-on-surface-variant"
            >
              sentiment_dissatisfied
            </span>
            <h1 className="text-lg font-bold">{i18n.t('common.unexpectedError')}</h1>
            <p className="text-sm text-on-surface-variant">
              {i18n.t('common.unexpectedErrorBody')}
            </p>
            <button
              onClick={() => {
                try {
                  sessionStorage.removeItem('chunk-reloaded');
                } catch {
                  // Storage blocked: the reload still helps.
                }
                window.location.reload();
              }}
              className="btn-primary"
            >
              {i18n.t('common.reload')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface SectionState {
  error: Error | null;
}

interface SectionProps extends Props {
  /** When this changes (the route), a shown error is cleared. Children are not remounted. */
  resetKey?: string;
}

/** One page failed; the rest of the app did not. See the file comment. */
export class SectionErrorBoundary extends Component<SectionProps, SectionState> {
  state: SectionState = { error: null };

  static getDerivedStateFromError(error: Error): SectionState {
    return { error };
  }

  componentDidUpdate(prev: SectionProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) return; // the root boundary handles and logs it
    console.error('[SectionErrorBoundary]', error?.stack ?? error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    // Re-thrown during render so the root boundary receives it and reloads.
    if (error && isChunkLoadError(error)) throw error;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto grid max-w-md place-items-center px-4 py-16 text-center" role="alert">
        <span aria-hidden className="material-symbols-outlined text-[40px] text-on-surface-variant">
          error
        </span>
        <h1 className="mt-3 font-heading text-lg font-bold text-on-surface">
          {i18n.t('common.sectionError')}
        </h1>
        <p className="mt-2 text-sm text-on-surface-variant">{i18n.t('common.sectionErrorBody')}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {/* Try the page again without reloading the app; a second crash just lands here again. */}
          <button className="btn-primary" onClick={() => this.setState({ error: null })}>
            {i18n.t('common.retry')}
          </button>
          <button className="btn-ghost" onClick={() => window.location.reload()}>
            {i18n.t('common.reload')}
          </button>
        </div>
      </div>
    );
  }
}

/** A missing chunk fixes itself on reload — but only once, or it is a loop. */
function isRecoverable(error: Error): boolean {
  try {
    return isChunkLoadError(error) && !sessionStorage.getItem('chunk-reloaded');
  } catch {
    // Storage can throw in a private window; without the guard a reload could
    // loop, so treat it as unrecoverable and show the retry screen instead.
    return false;
  }
}

function isChunkLoadError(error: Error): boolean {
  const msg = `${error?.name ?? ''} ${error?.message ?? ''}`;
  return (
    /ChunkLoadError/i.test(msg) ||
    /Loading chunk [\d]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /'text\/html'.*module/i.test(msg)
  );
}

import { Component, ReactNode } from 'react';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  /** A reload is already on its way, so there is nothing to say. */
  recovering: boolean;
}

/**
 * Catches render/lazy-import errors. The common case is a dynamic chunk that a
 * new deploy deleted while a tab held the old index.html — the import() rejects
 * and, without a boundary, React unmounts the whole tree (blank page). We detect
 * that class of error and reload once to pull the fresh build; anything else
 * shows a recoverable retry screen instead of a white screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false };

  static getDerivedStateFromError(error: Error): State {
    // Deciding here rather than in componentDidCatch is the difference between
    // a student seeing "something went wrong" and seeing nothing at all: this
    // runs before the first paint, componentDidCatch runs after it.
    return { error, recovering: isRecoverable(error) };
  }

  componentDidCatch(error: Error) {
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
        <div dir="rtl" className="grid min-h-screen place-items-center bg-slate-50 p-6 text-center">
          <div className="max-w-sm space-y-4">
            <div className="text-4xl">😕</div>
            <h1 className="text-lg font-bold text-slate-800">{i18n.t('common.unexpectedError')}</h1>
            <p className="text-sm text-slate-500">{i18n.t('common.unexpectedErrorBody')}</p>
            <button
              onClick={() => {
                sessionStorage.removeItem('chunk-reloaded');
                window.location.reload();
              }}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
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

import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render/lazy-import errors. The common case is a dynamic chunk that a
 * new deploy deleted while a tab held the old index.html — the import() rejects
 * and, without a boundary, React unmounts the whole tree (blank page). We detect
 * that class of error and reload once to pull the fresh build; anything else
 * shows a recoverable retry screen instead of a white screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error) && !sessionStorage.getItem('chunk-reloaded')) {
      // Reload once (guarded so we never loop) to fetch the current build.
      sessionStorage.setItem('chunk-reloaded', '1');
      window.location.reload();
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div dir="rtl" className="grid min-h-screen place-items-center bg-slate-50 p-6 text-center">
          <div className="max-w-sm space-y-4">
            <div className="text-4xl">😕</div>
            <h1 className="text-lg font-bold text-slate-800">حدث خطأ غير متوقع</h1>
            <p className="text-sm text-slate-500">
              نعتذر — حدث خطأ أثناء تحميل الصفحة. حاول إعادة التحميل.
            </p>
            <button
              onClick={() => {
                sessionStorage.removeItem('chunk-reloaded');
                window.location.reload();
              }}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              إعادة تحميل
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
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

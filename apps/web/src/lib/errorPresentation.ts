/**
 * Which failures are already on screen.
 *
 * Every failed mutation is toasted by the query client's MutationCache — the
 * safety net for row actions and background saves that have nowhere else to
 * say it. But most forms also render the same error inline (`<ErrorNote>`, a
 * message under a field), and the reader saw it twice: a red note in the modal
 * and the identical sentence in a toast over it. The guardian form was the
 * reported case; 136 `<ErrorNote>` sites had the same problem.
 *
 * Instead of asking every one of those sites to remember an opt-out flag, an
 * inline presentation *claims* the error object when it renders it, and the
 * cache waits a moment before toasting — long enough for the component to
 * re-render with the error — then stays quiet if something claimed it. A
 * failure nobody shows inline (the modal closed, a row action) still toasts.
 *
 * A WeakSet, so a claimed error is forgotten with the error itself.
 */
const claimed = new WeakSet<object>();

export function claimError(error: unknown): void {
  if (error && typeof error === 'object') claimed.add(error);
}

export function isClaimed(error: unknown): boolean {
  return !!error && typeof error === 'object' && claimed.has(error);
}

/**
 * How long the cache waits before toasting. React Query notifies observers on
 * a zero-delay timer and the component renders synchronously after that, so
 * an inline note claims within a few milliseconds; this leaves a wide margin
 * without making a genuine toast feel late.
 */
export const TOAST_CLAIM_WINDOW_MS = 150;

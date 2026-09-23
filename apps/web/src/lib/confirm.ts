import { create } from 'zustand';

/**
 * "Are you sure?", asked by the app instead of by the browser.
 *
 * Twenty-five screens called `window.confirm()`. That dialog cannot be
 * translated in place, cannot be laid out right-to-left, ignores every colour
 * and shape the reader has chosen, and blocks the main thread while it is up —
 * so an Arabic reader deleting a lesson got a left-aligned English-chrome box
 * in the middle of an Arabic page, and the app froze behind it.
 *
 * Deliberately outside React, exactly like `toast.ts`: the point is that a call
 * site changes from `if (confirm(msg))` to `if (await askConfirm(msg))` and
 * nothing else — no provider to thread, no hook rule to obey inside an event
 * handler, no state to add to a page that already has twenty-nine.
 *
 * Requests queue rather than overwrite. Only one can be on screen, but a second
 * arriving while the first is open must not be silently answered "no" — that
 * would turn a question the reader never saw into a decision.
 */

export interface ConfirmRequest {
  id: string;
  message: string;
  title?: string;
  /** Delete, revoke, end, clear: drawn as the error colour, never as the default. */
  danger?: boolean;
  /** Overrides the generic "Confirm" when a verb reads better on the button. */
  confirmLabel?: string;
}

interface PendingRequest extends ConfirmRequest {
  settle: (answer: boolean) => void;
}

interface ConfirmState {
  /** What is on screen now, or null. */
  current: PendingRequest | null;
  queue: PendingRequest[];
  ask: (request: PendingRequest) => void;
  /** Answers the visible request and shows the next one waiting. */
  answer: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  queue: [],
  ask: (request) =>
    set((s) => (s.current ? { queue: [...s.queue, request] } : { current: request })),
  answer: (value) => {
    const { current, queue } = get();
    if (!current) return;
    set({ current: queue[0] ?? null, queue: queue.slice(1) });
    current.settle(value);
  },
}));

/**
 * Ask the reader to confirm. Resolves true only if they say yes; dismissing —
 * Escape, the backdrop, Cancel — resolves false, which is what a destructive
 * action must treat as "do nothing".
 */
export function askConfirm(
  message: string,
  options: Omit<ConfirmRequest, 'id' | 'message'> = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().ask({
      id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      message,
      ...options,
      settle: resolve,
    });
  });
}

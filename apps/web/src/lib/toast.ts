import { create } from 'zustand';
import { errorMessage } from './errorMessage';

/**
 * Transient messages, shown as a card over the page.
 *
 * Deliberately outside React: the axios interceptor and the react-query
 * mutation cache are where most failures are first known about, and neither is
 * a component. `<AppToasts/>` subscribes and draws; nothing else needs to.
 *
 * Errors are deduplicated by their text while visible. A mutation that a screen
 * also reports inline, and a retry the reader triggers twice, both used to
 * stack the identical sentence three deep.
 */

export type ToastTone = 'error' | 'success' | 'info';

export interface AppToast {
  id: string;
  tone: ToastTone;
  message: string;
  /** Optional heading; most toasts are a single sentence and need none. */
  title?: string;
}

interface ToastState {
  toasts: AppToast[];
  push: (toast: Omit<AppToast, 'id'>) => string;
  dismiss: (id: string) => void;
}

const MAX_VISIBLE = 3;
/** Errors stay long enough to read and act on; confirmations get out of the way. */
const LIFETIME_MS: Record<ToastTone, number> = { error: 8_000, success: 3_500, info: 5_000 };

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const existing = get().toasts.find((x) => x.tone === toast.tone && x.message === toast.message);
    if (existing) return existing.id;
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({ toasts: [{ ...toast, id }, ...s.toasts].slice(0, MAX_VISIBLE) }));
    window.setTimeout(() => get().dismiss(id), LIFETIME_MS[toast.tone]);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Show a failure as a message a reader can act on — never the API's own words. */
export function toastError(error: unknown, title?: string): void {
  const message = errorMessage(error);
  if (!message) return;
  useToastStore.getState().push({ tone: 'error', message, title });
}

export function toastSuccess(message: string): void {
  useToastStore.getState().push({ tone: 'success', message });
}

export function toastInfo(message: string): void {
  useToastStore.getState().push({ tone: 'info', message });
}

import { useTranslation } from 'react-i18next';
import { useToastStore, type ToastTone } from '../lib/toast';

/**
 * Where every refusal the app produces is actually shown.
 *
 * The inline red note under a form (`ErrorNote`) stays — for a form, the error
 * belongs next to the field — but most failures happen where there is no form
 * to put one under: a row action, a background save, an upload. Those were
 * either silent or printed the API's English sentence in red, so this is the
 * surface they get instead.
 *
 * Mounted once, beside NotificationToasts, and offset above it so a refusal and
 * an arriving notification never sit on top of each other.
 */

const TONE: Record<ToastTone, { icon: string; card: string; chip: string }> = {
  error: {
    icon: 'error',
    card: 'border-error/30 bg-error-container',
    chip: 'bg-error text-on-error',
  },
  success: {
    icon: 'check_circle',
    card: 'border-outline-variant/40 bg-surface-container-lowest',
    chip: 'bg-primary text-on-primary',
  },
  info: {
    icon: 'info',
    card: 'border-outline-variant/40 bg-surface-container-lowest',
    chip: 'bg-primary-fixed text-on-primary-fixed',
  },
};

export default function AppToasts() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (!toasts.length) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-[calc(9.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col gap-2 sm:inset-x-auto sm:end-4 sm:top-20 sm:bottom-auto sm:w-96"
    >
      {toasts.map((toast) => {
        const tone = TONE[toast.tone];
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-2xl border p-3 shadow-modal ${tone.card}`}
          >
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone.chip}`}>
              <span className="material-symbols-outlined text-[20px]">{tone.icon}</span>
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              {toast.title && <p className="truncate text-sm font-bold">{toast.title}</p>}
              <p className="text-sm text-on-surface">{toast.message}</p>
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              aria-label={t('common.close')}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline transition hover:bg-surface-container"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { useMotion } from './motion';

export type UploadPhase = 'uploading' | 'working' | 'done' | 'failed';

/**
 * A file on its way up, drawn honestly.
 *
 * What this replaces was a 1.5px bar and nothing else: no name, no size, no
 * way to stop, and — worst — the same flat bar whether bytes were moving, the
 * server was transcoding, or the connection had quietly died. A teacher
 * watching a 400MB lesson upload could not tell "working" from "stuck", so the
 * reasonable thing to do was reload, which threw the upload away.
 *
 * So the three phases are drawn as three different things:
 *
 *   uploading  a real percentage, and a sheen that travels the *filled* part
 *              only. When the bytes stop the sheen stops with them — a stalled
 *              connection stops looking busy the moment it stalls, which is
 *              the one thing the old bar could never say.
 *   working    the server is doing something and has told us no number, so an
 *              honest sweep and no figure. Never a fake percentage creeping to
 *              90% and sitting there; that is a lie, and it is the lie that
 *              makes people reload.
 *   done       one settle and then still. Motion that never stops is motion
 *              nobody reads.
 *
 * Colours are the app's own tokens, so it reads in light and dark and follows a
 * published academy palette like everything else.
 */
export function UploadPanel({
  phase,
  pct,
  fileName,
  fileSize,
  note,
  onCancel,
  onRetry,
}: {
  phase: UploadPhase;
  /** 0–100. Ignored unless `phase` is `uploading`. */
  pct?: number;
  fileName?: string;
  /** Bytes. */
  fileSize?: number;
  /** What the server is doing, during `working`. */
  note?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const motion = useMotion();
  const clamped = Math.min(100, Math.max(0, Math.round(pct ?? 0)));
  const uploading = phase === 'uploading';
  const failed = phase === 'failed';
  const done = phase === 'done';

  const icon = failed ? 'error' : done ? 'check_circle' : uploading ? 'upload' : 'settings';
  const status = failed
    ? t('upload.failed')
    : done
      ? t('upload.done')
      : uploading
        ? t('upload.uploading')
        : (note ?? t('upload.working'));

  return (
    <div
      className={`rounded-2xl border p-3 ${
        failed ? 'border-error/40 bg-error-container/30' : 'border-outline-variant/60 bg-surface-container-lowest'
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
            failed
              ? 'bg-error/15 text-error'
              : done
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-primary/10 text-primary'
          } ${done && !motion.off ? 'up-pop' : ''}`}
        >
          <span
            className={`material-symbols-outlined text-[22px] ${
              phase === 'working' && !motion.off ? 'motion-safe:animate-spin' : ''
            }`}
          >
            {icon}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold" dir="auto">
            {fileName || t('upload.file')}
          </p>
          <p className="truncate text-xs text-on-surface-variant">
            {status}
            {fileSize ? ` · ${humanSize(fileSize)}` : ''}
          </p>
        </div>

        {/* A number only where there is a real one to show. */}
        {uploading && (
          <span className="shrink-0 font-heading text-sm font-bold tabular-nums text-on-surface" dir="ltr">
            {clamped}%
          </span>
        )}

        {uploading && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.cancel')}
            title={t('common.cancel')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline transition-colors hover:bg-error-container hover:text-on-error-container"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
        {failed && onRetry && (
          <button type="button" onClick={onRetry} className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
            {t('upload.retry')}
          </button>
        )}
      </div>

      {!failed && (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-container-high" dir="ltr">
          {phase === 'working' ? (
            // No width: there is no percentage, and pretending otherwise is the
            // whole thing this avoids.
            <div className={`h-full w-full text-primary ${motion.off ? 'bg-primary/40' : 'up-work'}`} />
          ) : (
            <div
              className={`relative h-full overflow-hidden rounded-full bg-primary transition-[width] ease-premium ${
                uploading && clamped > 0 && !motion.off ? 'up-sheen' : ''
              }`}
              style={{ width: `${done ? 100 : clamped}%`, transitionDuration: `${motion.dur * 420}ms` }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Bytes as something a person reads, in the units they already think in. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../lib/markdown';
import { MARKS, Mark, applyMark } from '../lib/markdown-marks';

/**
 * A description box that admits it understands formatting.
 *
 * A plain textarea gives no reason to believe `**عنوان**` will become anything,
 * so people either don't try or try once, see asterisks on the public page, and
 * stop. The preview is the whole point: it is the only place the teacher finds
 * out, before publishing, that the text does what they meant.
 *
 * The buttons mark up the text rather than opening a rich-text editor. The
 * stored value stays plain text — the same string the API already holds, still
 * readable anywhere this component is not.
 *
 * What the text actually becomes lives in `lib/markdown-marks`, as a pure
 * function of (text, selection, mark). This file is only the part that has to
 * touch a textarea: where the caret was, and putting it back.
 */
export function MarkdownEditor({
  value,
  onChange,
  maxLength,
  minHeight = 'min-h-24',
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
  minHeight?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  /**
   * The textarea itself, rather than `document.getElementById(id)`.
   *
   * The id is a caller's label for a field, not a promise of uniqueness — two
   * of these on one page, or a modal that renders while another is closing, and
   * the lookup finds the wrong box or none at all. Finding none was the quiet
   * failure: the selection read as `value.length`, so every button appended its
   * marks to the very end of the text instead of around the words the teacher
   * had highlighted.
   */
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Where to put the selection back after React has re-rendered the value. */
  const restore = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const sel = restore.current;
    if (!sel || !ref.current) return;
    restore.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(sel.start, sel.end);
  }, [value]);

  function apply(mark: Mark) {
    const el = ref.current;
    if (!el) return;
    const next = applyMark(value, el.selectionStart, el.selectionEnd, mark);
    // Marks that only ever shorten the text (toggling one off) are allowed
    // through at the limit; the guard is there to stop it growing past it.
    if (maxLength && next.value.length > maxLength && next.value.length > value.length) return;
    restore.current = { start: next.start, end: next.end };
    onChange(next.value);
  }

  /**
   * The shortcuts every text box on earth has. Without them the buttons are the
   * only way in, which is what made formatting feel like a chore rather than
   * something you do while typing.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const mark = key === 'b' ? MARKS[0] : key === 'i' ? MARKS[1] : null;
    if (!mark) return;
    e.preventDefault();
    apply(mark);
  }

  const over = maxLength ? value.length > maxLength : false;

  return (
    <div>
      {/* The toolbar stays put in preview, disabled rather than removed: taking
          the buttons away moved the preview toggle across the row, so the thing
          you were about to press again had wandered off. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {MARKS.map((mk) => (
          <button
            key={mk.key}
            type="button"
            disabled={preview}
            onClick={() => apply(mk)}
            title={t(`markdown.${mk.key}`)}
            aria-label={t(`markdown.${mk.key}`)}
            className="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="material-symbols-outlined text-[20px]">{mk.icon}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className={`ms-auto rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
            preview ? 'bg-primary text-on-primary' : 'text-primary hover:bg-surface-container-high'
          }`}
        >
          {preview ? t('markdown.edit') : t('markdown.preview')}
        </button>
      </div>

      {preview ? (
        // Same box, same height, so switching does not make the form jump.
        <div className={`input overflow-y-auto ${minHeight}`}>
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-outline">{t('markdown.previewEmpty')}</p>
          )}
        </div>
      ) : (
        <textarea
          ref={ref}
          id={id}
          className={`input ${minHeight}`}
          dir="auto"
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}

      {/* The title field counts its characters and this one did not, so the
          only sign of the limit was typing stopping for no stated reason. */}
      {maxLength != null && !preview && (
        <p
          className={`mt-1 text-end text-xs tabular-nums ${over ? 'text-error' : 'text-outline'}`}
          dir="ltr"
        >
          {value.length}/{maxLength}
        </p>
      )}
    </div>
  );
}

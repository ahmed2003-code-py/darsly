import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../lib/markdown';

/**
 * A description box that admits it understands formatting.
 *
 * A plain textarea gives no reason to believe `**عنوان**` will become anything,
 * so people either don't try or try once, see asterisks on the public page, and
 * stop. The preview tab is the whole point: it is the only place the teacher
 * finds out, before publishing, that the text does what they meant.
 *
 * The toolbar buttons wrap the selection rather than opening a rich-text
 * editor. The stored value stays plain text — the same string the API already
 * holds, still readable if it is ever shown somewhere this component is not.
 */
const MARKS = [
  { key: 'bold', icon: 'format_bold', wrap: '**' },
  { key: 'italic', icon: 'format_italic', wrap: '*' },
  { key: 'bullet', icon: 'format_list_bulleted', line: '- ' },
  { key: 'number', icon: 'format_list_numbered', line: '1. ' },
  { key: 'heading', icon: 'title', line: '## ' },
] as const;

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

  function apply(mark: (typeof MARKS)[number]) {
    const el = document.getElementById(id ?? '') as HTMLTextAreaElement | null;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    let next: string;
    let caret: number;

    if ('wrap' in mark) {
      next = value.slice(0, start) + mark.wrap + selected + mark.wrap + value.slice(end);
      caret = start + mark.wrap.length + selected.length;
    } else {
      // Prefix every selected line, so marking three lines as a list takes one
      // click rather than three.
      const from = value.lastIndexOf('\n', start - 1) + 1;
      const body = value.slice(from, end) || selected;
      const marked = body.split('\n').map((l) => (l.startsWith(mark.line) ? l : mark.line + l)).join('\n');
      next = value.slice(0, from) + marked + value.slice(end);
      caret = from + marked.length;
    }
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {!preview &&
          MARKS.map((mk) => (
            <button key={mk.key} type="button" onClick={() => apply(mk)}
              title={t(`markdown.${mk.key}`)} aria-label={t(`markdown.${mk.key}`)}
              className="grid h-8 w-8 place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-high">
              <span className="material-symbols-outlined text-[20px]">{mk.icon}</span>
            </button>
          ))}
        <button type="button" onClick={() => setPreview((p) => !p)}
          className={`ms-auto rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
            preview ? 'bg-primary text-on-primary' : 'text-primary hover:bg-surface-container-high'
          }`}>
          {preview ? t('markdown.edit') : t('markdown.preview')}
        </button>
      </div>

      {preview ? (
        // Same box, same height, so switching tabs does not make the form jump.
        <div className={`input overflow-y-auto ${minHeight}`}>
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-outline">{t('markdown.previewEmpty')}</p>
          )}
        </div>
      ) : (
        <textarea id={id} className={`input ${minHeight}`} dir="auto" maxLength={maxLength}
          value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

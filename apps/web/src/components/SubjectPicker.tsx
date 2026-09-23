import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRACK_ORDER, subjectMatches, subjectName, type Subject } from '../lib/subjects';

/**
 * What a teacher teaches, picked rather than typed.
 *
 * The catalogue is long on purpose — two school systems, and the maths a
 * secondary teacher takes is not one subject but four — so scrolling it is the
 * slow way to use it and the search box is the fast one. It reads both names at
 * once, so "Math" finds the subject whatever language the app is in.
 *
 * Choices stay visible as chips above the list. A teacher who picks four
 * subjects and then scrolls the list has no other way to see what they have
 * already said, and re-picking a subject they cannot see is the mistake this
 * costs nothing to prevent.
 */
export default function SubjectPicker({
  subjects,
  value,
  onChange,
  max = 12,
}: {
  subjects: Subject[];
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
}) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  const [q, setQ] = useState('');

  const byId = useMemo(() => new Map(subjects.map((s) => [s.id, s])), [subjects]);
  const groups = useMemo(() => {
    const hits = subjects.filter((s) => subjectMatches(s, q));
    return TRACK_ORDER.map((track) => ({
      track,
      items: hits.filter((s) => s.track === track),
    })).filter((g) => g.items.length);
  }, [subjects, q]);

  const toggle = (id: string) => {
    if (value.includes(id)) return onChange(value.filter((x) => x !== id));
    if (value.length >= max) return;
    onChange([...value, id]);
  };

  const chosen = value.map((id) => byId.get(id)).filter((s): s is Subject => !!s);

  return (
    <div>
      {chosen.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chosen.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-bold text-on-primary"
            >
              {subjectName(s, ar)}
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          ))}
        </div>
      )}

      <div className="mb-2 flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 focus-within:border-primary">
        <span className="material-symbols-outlined text-[18px] text-outline">search</span>
        <input
          className="w-full bg-transparent text-sm outline-none placeholder:text-outline"
          placeholder={t('subjects.searchPh')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label={t('common.clear')}>
            <span className="material-symbols-outlined text-[18px] text-outline">close</span>
          </button>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border border-outline-variant p-2">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-outline">{t('subjects.noMatch')}</p>
        ) : (
          groups.map((g) => (
            <div key={g.track} className="mb-2 last:mb-0">
              <p className="px-1 pb-1 text-[11px] font-bold uppercase tracking-wide text-outline">
                {t(`subjects.track.${g.track}`)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((s) => {
                  const on = value.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                        on
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-outline-variant hover:border-primary hover:text-primary'
                      }`}
                    >
                      {subjectName(s, ar)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

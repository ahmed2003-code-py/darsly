import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Choosing from what the platform already knows, instead of typing it.
 *
 * These two fields were free text separated by commas, which asked a teacher to
 * spell out "الأول الثانوي، الثاني الثانوي، الثالث الثانوي" from memory and
 * accepted "الثانوية" — a different string meaning the same thing, which the
 * generator then had to guess at. The years and the subjects are rows in the
 * database; offering them is both less work and less ambiguity.
 *
 * Anything already typed that is not one of them is kept as it is. A teacher
 * who wrote something the list does not have has said something real, and a new
 * control is not a reason to throw it away.
 */
export function PickList({
  options,
  value,
  onChange,
  addLabel,
  addPlaceholder,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  addPlaceholder: string;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState('');
  const has = (v: string) => value.includes(v);
  const toggle = (v: string) => onChange(has(v) ? value.filter((x) => x !== v) : [...value, v]);

  // Whatever is selected but not on offer — typed before this control existed,
  // or added by hand just now.
  const custom = value.filter((v) => !options.includes(v));

  const add = () => {
    const v = adding.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setAdding('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Chip key={o} on={has(o)} onClick={() => toggle(o)}>
            {o}
          </Chip>
        ))}
        {custom.map((o) => (
          <Chip key={o} on onClick={() => toggle(o)}>
            {o}
          </Chip>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-outline">{addLabel}</span>
        <input
          className="input h-9 w-auto min-w-0 flex-1 py-1 text-sm sm:max-w-xs"
          value={adding}
          placeholder={addPlaceholder}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // A form field that submits the whole form on Enter would save a
              // half-finished page instead of adding one word.
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!adding.trim()}
          className="btn-ghost h-9 px-3 py-0 text-sm disabled:opacity-40"
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

/**
 * The same list, in the groups people actually think in.
 *
 * Fifteen years side by side is a wall. A teacher thinks "I teach secondary",
 * so the stage is a control of its own: pressing it takes all three years at
 * once, and pressing it again gives them back.
 */
export function StagePickList({
  groups,
  value,
  onChange,
  addLabel,
  addPlaceholder,
}: {
  groups: { label: string; items: string[] }[];
  value: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  addPlaceholder: string;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState('');
  const known = groups.flatMap((g) => g.items);
  const custom = value.filter((v) => !known.includes(v));

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const toggleGroup = (items: string[]) => {
    const all = items.every((i) => value.includes(i));
    onChange(all ? value.filter((v) => !items.includes(v)) : [...new Set([...value, ...items])]);
  };

  const add = () => {
    const v = adding.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setAdding('');
  };

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const all = g.items.every((i) => value.includes(i));
        const some = !all && g.items.some((i) => value.includes(i));
        return (
          <div key={g.label} className="rounded-xl border border-outline-variant p-3">
            <button
              type="button"
              onClick={() => toggleGroup(g.items)}
              aria-pressed={all}
              className={`mb-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold transition ${
                all
                  ? 'bg-primary text-on-primary'
                  : some
                    ? 'bg-primary-fixed text-on-primary-fixed'
                    : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {all ? 'check_circle' : some ? 'remove' : 'radio_button_unchecked'}
              </span>
              {g.label}
            </button>
            <div className="flex flex-wrap gap-2">
              {g.items.map((i) => (
                <Chip key={i} on={value.includes(i)} onClick={() => toggle(i)}>
                  {i}
                </Chip>
              ))}
            </div>
          </div>
        );
      })}

      {custom.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {custom.map((c) => (
            <Chip key={c} on onClick={() => toggle(c)}>
              {c}
            </Chip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-outline">{addLabel}</span>
        <input
          className="input h-9 w-auto min-w-0 flex-1 py-1 text-sm sm:max-w-xs"
          value={adding}
          placeholder={addPlaceholder}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!adding.trim()}
          className="btn-ghost h-9 px-3 py-0 text-sm disabled:opacity-40"
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
        on
          ? 'border-primary bg-primary text-on-primary'
          : 'border-outline-variant text-on-surface-variant hover:border-outline hover:text-on-surface'
      }`}
    >
      {children}
    </button>
  );
}

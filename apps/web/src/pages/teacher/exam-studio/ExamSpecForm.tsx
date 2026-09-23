import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '../../../components/ui';
import { ExamSpec, SpecQuestionType } from '../../../lib/paperImport';

const TYPES: SpecQuestionType[] = ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'];

/**
 * What exam the teacher wants out of the material they uploaded.
 *
 * Asked *after* the material has been read, which is deliberate: reading is
 * cheap and tells us whether there is anything here, and writing questions
 * before anyone has said how many is a bill for a guess.
 *
 * Only the three question kinds the exam engine actually stores are on this
 * form. A fourth — "مقالي" as a separate type — would be a promise the exam
 * cannot keep: it would become a written answer anyway, and the teacher would
 * only find out when they opened the exam.
 */
export function ExamSpecForm({
  initial,
  chunkHint,
  onSubmit,
  submitting,
}: {
  initial: ExamSpec;
  /** How much material there is, so the count field can be judged against it. */
  chunkHint?: number;
  onSubmit: (spec: ExamSpec) => void;
  submitting?: boolean;
}) {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<ExamSpec>(initial);

  const typeTotal = useMemo(
    () => TYPES.reduce((n, type) => n + (spec.types[type] ?? 0), 0),
    [spec.types],
  );
  const balanced = typeTotal === spec.questionCount;

  const set = (patch: Partial<ExamSpec>) => setSpec((s) => ({ ...s, ...patch }));

  /** Changing the total re-spreads the kinds in the same proportions, so the
   *  form stays valid instead of demanding the teacher fix arithmetic. */
  const setCount = (count: number) => {
    const safe = Math.max(1, Math.min(200, count || 1));
    const total = typeTotal || 1;
    const next = { ...spec.types };
    let used = 0;
    TYPES.forEach((type, i) => {
      if (i === TYPES.length - 1) next[type] = Math.max(0, safe - used);
      else {
        next[type] = Math.round(((spec.types[type] ?? 0) / total) * safe);
        used += next[type];
      }
    });
    set({ questionCount: safe, types: next });
  };

  return (
    <div className="card">
      <p className="mb-1 font-heading text-lg font-semibold text-on-surface">
        {t('examStudio.specTitle')}
      </p>
      <p className="mb-6 text-sm text-on-surface-variant">{t('examStudio.specHint')}</p>

      <Field label={t('examStudio.examTitle')}>
        <input
          className="input"
          value={spec.title}
          placeholder={t('examStudio.examTitlePlaceholder')}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('examStudio.questionCount')}
          hint={chunkHint ? t('examStudio.materialHint', { n: chunkHint }) : undefined}
        >
          <input
            className="input"
            type="number"
            min={1}
            max={200}
            value={spec.questionCount}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </Field>

        <Field label={t('examStudio.difficulty')}>
          <select
            className="input"
            value={spec.difficulty}
            onChange={(e) => set({ difficulty: e.target.value as ExamSpec['difficulty'] })}
          >
            {(['EASY', 'MEDIUM', 'HARD', 'MIXED'] as const).map((d) => (
              <option key={d} value={d}>
                {t(`examStudio.difficultyOption.${d}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {spec.difficulty === 'MIXED' && (
        <div className="mb-4 grid gap-3 rounded-xl bg-surface-container-low p-4 sm:grid-cols-3">
          {(['EASY', 'MEDIUM', 'HARD'] as const).map((level) => (
            <label key={level} className="block">
              <span className="mb-1 block text-sm text-on-surface-variant">
                {t(`examStudio.difficultyOption.${level}`)} %
              </span>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={spec.mix[level]}
                onChange={(e) =>
                  set({ mix: { ...spec.mix, [level]: Math.max(0, Number(e.target.value) || 0) } })
                }
              />
            </label>
          ))}
        </div>
      )}

      <p className="mb-2 mt-2 font-heading font-semibold text-on-surface">
        {t('examStudio.typesTitle')}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {TYPES.map((type) => (
          <label key={type} className="block">
            <span className="mb-1 block text-sm text-on-surface-variant">
              {t(`paper.type.${type}`)}
            </span>
            <input
              className="input"
              type="number"
              min={0}
              max={200}
              value={spec.types[type] ?? 0}
              onChange={(e) =>
                set({
                  types: { ...spec.types, [type]: Math.max(0, Number(e.target.value) || 0) },
                })
              }
            />
          </label>
        ))}
      </div>
      <p
        className={`mt-2 text-sm ${balanced ? 'text-on-surface-variant' : 'text-error'}`}
        dir="auto"
      >
        {balanced
          ? t('examStudio.typesBalanced', { n: typeTotal })
          : t('examStudio.typesUnbalanced', { got: typeTotal, want: spec.questionCount })}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label={t('examStudio.timeLimit')} hint={t('examStudio.timeLimitHint')}>
          <input
            className="input"
            type="number"
            min={1}
            max={1440}
            value={spec.timeLimitMin ?? ''}
            onChange={(e) => set({ timeLimitMin: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label={t('examStudio.marks')} hint={t('examStudio.marksHint')}>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={spec.marksPerQuestion ?? ''}
            onChange={(e) =>
              set({ marksPerQuestion: e.target.value ? Number(e.target.value) : null })
            }
          />
        </Field>
      </div>

      <Field label={t('examStudio.language')}>
        <select
          className="input"
          value={spec.language}
          onChange={(e) => set({ language: e.target.value as ExamSpec['language'] })}
        >
          {(['AUTO', 'AR', 'EN'] as const).map((l) => (
            <option key={l} value={l}>
              {t(`examStudio.languageOption.${l}`)}
            </option>
          ))}
        </select>
      </Field>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={spec.shuffle}
            onChange={(e) => set({ shuffle: e.target.checked })}
          />
          {t('examStudio.shuffle')}
        </label>
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={spec.showAnswers}
            onChange={(e) => set({ showAnswers: e.target.checked })}
          />
          {t('examStudio.showAnswers')}
        </label>
      </div>

      {/* The teacher reads back what they asked for before it is written. */}
      <div className="mt-6 rounded-xl bg-surface-container-low p-4 text-sm text-on-surface">
        <p className="mb-1 font-heading font-semibold">{t('examStudio.summaryTitle')}</p>
        <p dir="auto">
          {t('examStudio.summary', {
            count: spec.questionCount,
            mcq: spec.types.MCQ ?? 0,
            tf: spec.types.TRUE_FALSE ?? 0,
            short: spec.types.SHORT_ANSWER ?? 0,
            difficulty: t(`examStudio.difficultyOption.${spec.difficulty}`),
          })}
        </p>
      </div>

      <button
        className="btn-primary mt-6"
        disabled={!balanced || submitting}
        onClick={() => onSubmit(spec)}
      >
        {submitting ? t('examStudio.generating') : t('examStudio.generate')}
      </button>
    </div>
  );
}

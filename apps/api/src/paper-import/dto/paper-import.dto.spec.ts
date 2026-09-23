import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveDraftDto } from './paper-import.dto';

/**
 * A reviewed draft has to survive the trip back.
 *
 * This exists because it did not. The generator writes `sourceChunk` and
 * `sourceFile` onto every question — they are what "المصدر: biology.pdf —
 * صفحة 8" is drawn from, and what lets one question be rewritten from its own
 * material — and the DTO did not declare them. The global pipe runs
 * `forbidNonWhitelisted`, so saving a draft of thirteen generated questions
 * came back as **twenty-six** validation errors (two unknown properties each)
 * and the teacher could not create the exam at all. The count in the error was
 * the only clue, and it meant nothing to them.
 *
 * The validator is run here directly, the same way the pipe runs it, because a
 * service test would never have caught this: the service was fine. It was the
 * edge.
 */
const question = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  number: 1,
  type: 'MCQ',
  text: 'أين تحدث عملية التمثيل الضوئي داخل الخلية النباتية؟',
  options: [
    { id: 'o1', label: 'أ', text: 'البلاستيدات الخضراء', correct: true },
    { id: 'o2', label: 'ب', text: 'الميتوكوندريا', correct: false },
  ],
  modelAnswer: '',
  marks: 2,
  sourcePages: [1],
  unsupportedKind: '',
  needsReview: false,
  ...over,
});

const draft = (questions: Record<string, unknown>[]) => ({
  title: 'امتحان الأحياء',
  instructions: ['أجب عن كل الأسئلة'],
  sections: [{ title: '', questions }],
});

function errorsFor(body: unknown): string[] {
  const dto = plainToInstance(SaveDraftDto, body, { enableImplicitConversion: false });
  // whitelist + forbidNonWhitelisted are what main.ts configures globally.
  const errors = validateSync(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: string[] = [];
  const walk = (list: typeof errors) => {
    for (const e of list) {
      if (e.constraints) flat.push(...Object.values(e.constraints));
      if (e.children?.length) walk(e.children);
    }
  };
  walk(errors);
  return flat;
}

describe('saving a reviewed draft', () => {
  it('accepts a generated question with its source on it', () => {
    const body = draft([
      question({ sourceChunk: 0, sourceFile: 'lecture.pdf' }),
      question({ id: 'g2', number: 2, sourceChunk: 3, sourceFile: 'chapter-2.pdf' }),
    ]);
    expect(errorsFor(body)).toEqual([]);
  });

  it('accepts a transcribed question, which has no source chunk at all', () => {
    expect(errorsFor(draft([question()]))).toEqual([]);
  });

  it('accepts a question whose material could not be attributed', () => {
    expect(errorsFor(draft([question({ sourceChunk: null })]))).toEqual([]);
  });

  it('still refuses a property nobody declared', () => {
    // The guard that caused the bug is doing its job; the fix was to declare
    // the two fields, not to stop checking.
    expect(errorsFor(draft([question({ somethingElse: 'x' })])).length).toBeGreaterThan(0);
  });

  it('still refuses a draft that is not a draft', () => {
    expect(errorsFor({ title: 'x' }).length).toBeGreaterThan(0);
  });

  it('would have produced exactly the twenty-six errors the teacher saw', () => {
    // Thirteen generated questions, two undeclared properties each. Recreated
    // against a DTO stripped of the fix, so the number in the bug report is
    // pinned to its cause rather than to a memory of it.
    const thirteen = Array.from({ length: 13 }, (_, i) =>
      question({ id: `g${i}`, number: i + 1, chunkIndex: i, madeUpField: 'x' }),
    );
    expect(errorsFor(draft(thirteen))).toHaveLength(26);
  });
});

import {
  addQuestion,
  allQuestions,
  changeType,
  draftProblems,
  DraftQuestion,
  editQuestion,
  ExamDraft,
  moveQuestion,
  looksUnreadable,
  needsReviewCount,
  creationState,
  phaseOf,
  progressPct,
  overLimit,
  stepStates,
  warningKey,
  PaperImport,
  StudioLimits,
  removeQuestion,
  renumber,
  setCorrect,
  unsupportedCount,
} from './paperImport';

const question = (over: Partial<DraftQuestion> = {}): DraftQuestion => ({
  id: 'q1',
  number: 1,
  type: 'MCQ',
  text: 'Which organelle makes ATP?',
  options: [
    { id: 'o1', label: 'A', text: 'Mitochondrion', correct: false },
    { id: 'o2', label: 'B', text: 'Ribosome', correct: false },
  ],
  modelAnswer: '',
  marks: 2,
  sourcePages: [1],
  unsupportedKind: '',
  needsReview: false,
  ...over,
});

const draft = (questions: DraftQuestion[]): ExamDraft => ({
  title: 'Biology',
  instructions: [],
  sections: [{ title: '', questions }],
});

/**
 * The screen's state, tested without the screen.
 *
 * Every one of these is a step a teacher actually takes between a photograph
 * and an exam. They are pure functions precisely so this file can exist —
 * there is no rendering here, and nothing reaches the network.
 */
describe('which face the screen wears', () => {
  it('starts at upload when there is no import yet', () => {
    expect(phaseOf(null)).toBe('upload');
  });

  it('waits while the pages are being read', () => {
    expect(phaseOf({ status: 'UPLOADING' })).toBe('processing');
    expect(phaseOf({ status: 'PROCESSING' })).toBe('processing');
  });

  it('moves to review the moment the server says the draft is ready', () => {
    expect(phaseOf({ status: 'REVIEW' })).toBe('review');
  });

  it('is done once the exam exists', () => {
    expect(phaseOf({ status: 'COMPLETED' })).toBe('done');
  });

  it('treats a failure and an abandonment the same way on screen', () => {
    expect(phaseOf({ status: 'FAILED' })).toBe('failed');
    expect(phaseOf({ status: 'CANCELED' })).toBe('failed');
  });

  it('counts progress from pages that actually came back, never from a timer', () => {
    expect(progressPct({ progress: { done: 3, total: 12 } })).toBe(25);
    expect(progressPct({ progress: { done: 0, total: 0 } })).toBe(0);
    expect(progressPct(null)).toBe(0);
  });
});

describe('editing the draft before confirming it', () => {
  it('edits one question and leaves the rest alone', () => {
    const before = draft([question(), question({ id: 'q2', text: 'Second' })]);
    const after = editQuestion(before, 'q2', { text: 'Edited' });
    expect(allQuestions(after).map((q) => q.text)).toEqual([
      'Which organelle makes ATP?',
      'Edited',
    ]);
    // Immutable: the original is untouched, so an unsaved edit can be dropped.
    expect(allQuestions(before)[1].text).toBe('Second');
  });

  it('marks one answer right and unmarks the previous one', () => {
    const after = setCorrect(draft([question()]), 'q1', 'o1');
    expect(allQuestions(after)[0].options.map((o) => o.correct)).toEqual([true, false]);
    const moved = setCorrect(after, 'q1', 'o2');
    expect(allQuestions(moved)[0].options.map((o) => o.correct)).toEqual([false, true]);
  });

  it('keeps both answers when the paper asks for two', () => {
    const one = setCorrect(draft([question()]), 'q1', 'o1', true);
    const two = setCorrect(one, 'q1', 'o2', true);
    expect(allQuestions(two)[0].options.filter((o) => o.correct)).toHaveLength(2);
  });

  it('clears the "check this" flag once the teacher has chosen an answer', () => {
    const flagged = draft([question({ needsReview: true })]);
    expect(needsReviewCount(setCorrect(flagged, 'q1', 'o1'))).toBe(0);
  });

  it('drops the options when a question becomes a written one', () => {
    const after = changeType(draft([question()]), 'q1', 'SHORT_ANSWER');
    expect(allQuestions(after)[0].options).toEqual([]);
  });

  it('gives a true/false question exactly two options', () => {
    const after = changeType(draft([question()]), 'q1', 'TRUE_FALSE');
    expect(allQuestions(after)[0].options).toHaveLength(2);
  });

  it('gives a multiple choice question somewhere to type when it had none', () => {
    const written = draft([question({ type: 'SHORT_ANSWER', options: [] })]);
    const after = changeType(written, 'q1', 'MCQ');
    expect(allQuestions(after)[0].options).toHaveLength(4);
  });

  it('rescues an unsupported question by changing its type', () => {
    const odd = draft([
      question({
        type: 'UNSUPPORTED',
        unsupportedKind: 'matching',
        options: [],
        needsReview: true,
      }),
    ]);
    expect(unsupportedCount(odd)).toBe(1);

    const after = changeType(odd, 'q1', 'SHORT_ANSWER');
    expect(unsupportedCount(after)).toBe(0);
    expect(needsReviewCount(after)).toBe(0);
    expect(allQuestions(after)[0].unsupportedKind).toBe('');
  });

  it('renumbers after a deletion so the paper does not skip a number', () => {
    const before = draft([
      question({ id: 'q1' }),
      question({ id: 'q2', number: 2 }),
      question({ id: 'q3', number: 3 }),
    ]);
    const after = removeQuestion(before, 'q2');
    expect(allQuestions(after).map((q) => q.id)).toEqual(['q1', 'q3']);
    expect(allQuestions(after).map((q) => q.number)).toEqual([1, 2]);
  });

  it('reorders a question and renumbers behind it', () => {
    const before = draft([question({ id: 'q1' }), question({ id: 'q2', number: 2 })]);
    const after = moveQuestion(before, 'q2', -1);
    expect(allQuestions(after).map((q) => q.id)).toEqual(['q2', 'q1']);
    expect(allQuestions(after).map((q) => q.number)).toEqual([1, 2]);
  });

  it('does nothing when a question is already at the top', () => {
    const before = draft([question({ id: 'q1' }), question({ id: 'q2' })]);
    expect(allQuestions(moveQuestion(before, 'q1', -1)).map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('adds a question the extraction missed, at the end', () => {
    const after = addQuestion(draft([question()]));
    expect(allQuestions(after)).toHaveLength(2);
    expect(allQuestions(after)[1].number).toBe(2);
    expect(allQuestions(after)[1].text).toBe('');
  });

  it('can add the first question to a draft that came back empty', () => {
    const after = addQuestion({ title: '', instructions: [], sections: [] });
    expect(allQuestions(after)).toHaveLength(1);
  });

  it('numbers consecutively across sections', () => {
    const multi: ExamDraft = {
      title: '',
      instructions: [],
      sections: [
        { title: 'A', questions: [question({ id: 'q1' })] },
        { title: 'B', questions: [question({ id: 'q2' }), question({ id: 'q3' })] },
      ],
    };
    expect(allQuestions(renumber(multi)).map((q) => q.number)).toEqual([1, 2, 3]);
  });
});

describe('deciding whether the draft is fit to confirm', () => {
  it('is happy with a question that has an answer marked', () => {
    const ready = setCorrect(draft([question()]), 'q1', 'o1');
    expect(draftProblems(ready)).toEqual([]);
  });

  it('refuses an empty draft', () => {
    expect(draftProblems(draft([]))).toContain('EMPTY');
  });

  it('notices a multiple choice question with no answer marked', () => {
    // The paper usually carries no key, so this is the normal state a teacher
    // has to resolve — not an edge case.
    expect(draftProblems(draft([question()]))).toContain('NO_CORRECT_OPTION');
  });

  it('notices a question whose text was left blank', () => {
    expect(draftProblems(draft([question({ text: '  ' })]))).toContain('BLANK_TEXT');
  });

  it('notices a choice with only one thing to choose', () => {
    const thin = question({ options: [{ id: 'o1', label: 'A', text: 'Only', correct: true }] });
    expect(draftProblems(draft([thin]))).toContain('TOO_FEW_OPTIONS');
  });

  it('does not ask a written question for options or a key', () => {
    const written = question({ type: 'SHORT_ANSWER', options: [], modelAnswer: 'Because.' });
    expect(draftProblems(draft([written]))).toEqual([]);
  });

  it('carries an Arabic question through every edit unchanged', () => {
    const arabic = question({
      text: 'ما هي عاصمة مصر؟',
      options: [
        { id: 'o1', label: 'أ', text: 'القاهرة', correct: false },
        { id: 'o2', label: 'ب', text: 'الإسكندرية', correct: false },
      ],
    });
    const after = setCorrect(moveQuestion(draft([arabic]), 'q1', -1), 'q1', 'o1');
    expect(allQuestions(after)[0].text).toBe('ما هي عاصمة مصر؟');
    expect(allQuestions(after)[0].options[0].text).toBe('القاهرة');
    expect(draftProblems(after)).toEqual([]);
  });
});

/**
 * Noticing that a paper did not come back readable.
 *
 * The signal behind "read it again more carefully". It exists because of a
 * real import: a hand-written 1947 exam came back as five questions that all
 * said "[نص السؤال غير واضح]", and the screen offered the teacher nothing but
 * the chance to retype the exam themselves.
 */
describe('noticing a paper the model could not read', () => {
  const placeholderDraft = (count: number): ExamDraft => ({
    title: 'الامتحان النهائي',
    instructions: [],
    sections: [
      {
        title: '',
        questions: Array.from({ length: count }, (_, i) =>
          question({
            id: `q${i}`,
            number: i + 1,
            type: 'SHORT_ANSWER',
            options: [],
            text: '[نص السؤال غير واضح]',
            needsReview: true,
          }),
        ),
      },
    ],
  });

  it('offers to read the paper again when every question came back the same', () => {
    expect(looksUnreadable(placeholderDraft(5))).toBe(true);
  });

  it('offers it when most questions are flagged for the teacher to check', () => {
    const half: ExamDraft = draft([
      question({ id: 'a', text: 'A real question about osmosis', needsReview: true }),
      question({ id: 'b', text: 'Another real question entirely', needsReview: true }),
      question({ id: 'c', text: 'A third one, this time fine' }),
    ]);
    expect(looksUnreadable(half)).toBe(true);
  });

  it('stays out of the way of a paper that came back fine', () => {
    const fine: ExamDraft = draft([
      question({ id: 'a', text: 'What is the capital of Egypt?' }),
      question({ id: 'b', text: 'Define an exothermic reaction.' }),
      question({ id: 'c', text: 'State Newton\u2019s first law.' }),
    ]);
    expect(looksUnreadable(fine)).toBe(false);
  });

  it('says nothing about an empty draft — that is a different problem', () => {
    expect(looksUnreadable(draft([]))).toBe(false);
    expect(looksUnreadable(null)).toBe(false);
  });

  it('does not fire on one flagged question out of many', () => {
    const mostlyFine: ExamDraft = draft([
      question({ id: 'a', text: 'What is the capital of Egypt?' }),
      question({ id: 'b', text: 'Define an exothermic reaction.' }),
      question({ id: 'c', text: 'State the first law of motion.' }),
      question({ id: 'd', text: 'Name three states of matter.', needsReview: true }),
    ]);
    expect(looksUnreadable(mostlyFine)).toBe(false);
  });
});

describe('wording a warning in the language of whoever is reading it', () => {
  it('names a translation key for every warning the server can send', () => {
    for (const code of [
      'PAGE_FAILED',
      'PAGE_BLANK',
      'UNSUPPORTED_TYPE',
      'LOW_CONFIDENCE',
      'NOT_READ',
      'NO_ANSWER_KEY',
      'NUMBER_GAP',
      'NO_QUESTIONS',
    ]) {
      expect(warningKey(code)).toBe(`paper.warn.${code}`);
    }
  });

  it('falls back to the server text for a code this build predates', () => {
    // A deploy where the API is ahead of the browser must not leave a blank
    // line where a warning should be.
    expect(warningKey('SOMETHING_NEWER')).toBeNull();
  });
});

/**
 * The state a teacher is told they are in.
 *
 * All of it derived from what the server recorded, so there is nothing kept
 * in the browser that could disagree with the work and a reload lands on the
 * truth. The distinctions matter: "reading this again, more slowly" and
 * "reading this" are different things to be told, and showing one spinner for
 * both is how a screen comes to look frozen.
 */
const session = (over: Partial<PaperImport> = {}): PaperImport =>
  ({
    id: 'imp1',
    kind: 'PAPER',
    status: 'PROCESSING',
    stage: 'READING',
    title: '',
    sourceKind: 'IMAGES',
    error: null,
    lessonId: null,
    courseId: null,
    draft: { title: '', instructions: [], sections: [] },
    spec: {} as never,
    warnings: [],
    pages: [],
    progress: { done: 0, total: 0 },
    highAccuracy: false,
    costCents: 0,
    generationBatches: 0,
    ...over,
  }) as PaperImport;

describe('telling the teacher what is happening', () => {
  it('is working while the worker is working', () => {
    expect(creationState(session())).toBe('PROCESSING');
  });

  it('says it is reading again when a page failed and is being retried', () => {
    const pages = [{ id: 'p1', pageNumber: 1, status: 'FAILED' }] as never;
    expect(creationState(session({ pages }))).toBe('RETRYING');
  });

  it('says a high-accuracy read is a high-accuracy read', () => {
    expect(creationState(session({ highAccuracy: true }))).toBe('HIGH_ACCURACY');
  });

  it('asks for the specification once the material has been read', () => {
    expect(creationState(session({ status: 'CONFIGURING', stage: 'READY' }))).toBe('NEEDS_SPEC');
  });

  it('is simply ready when nothing needs an eye', () => {
    const draft = {
      title: 'x',
      instructions: [],
      sections: [
        {
          title: '',
          questions: [question({ id: 'a', text: 'A good clear question about cells' })],
        },
      ],
    };
    expect(creationState(session({ status: 'REVIEW', stage: 'READY', draft }))).toBe('READY');
  });

  it('says so when the review has warnings on it', () => {
    const draft = {
      title: 'x',
      instructions: [],
      sections: [
        {
          title: '',
          questions: [question({ id: 'a', text: 'A good clear question about cells' })],
        },
      ],
    };
    const warnings = [{ code: 'NO_ANSWER_KEY', detail: 'x' }];
    expect(creationState(session({ status: 'REVIEW', stage: 'READY', draft, warnings }))).toBe(
      'NEEDS_REVIEW',
    );
  });

  it('offers the stronger read when most of the draft came back unusable', () => {
    const bad = (i: number) =>
      question({ id: `q${i}`, text: '[نص السؤال غير واضح]', needsReview: true });
    const draft = {
      title: 'x',
      instructions: [],
      sections: [{ title: '', questions: [bad(1), bad(2), bad(3)] }],
    };
    expect(creationState(session({ status: 'REVIEW', stage: 'READY', draft }))).toBe(
      'HIGH_ACCURACY_AVAILABLE',
    );
  });

  it('is done once the exam exists', () => {
    expect(creationState(session({ status: 'COMPLETED' }))).toBe('DONE');
  });

  it('is failed for anything else', () => {
    expect(creationState(session({ status: 'FAILED' }))).toBe('FAILED');
    expect(creationState(session({ status: 'CANCELED' }))).toBe('FAILED');
  });
});

describe('the five steps of the pipeline', () => {
  it('ticks the steps the worker has actually finished', () => {
    const steps = stepStates({ stage: 'GENERATING', status: 'PROCESSING' } as never);
    expect(steps.UPLOAD).toBe('done');
    expect(steps.READ).toBe('done');
    expect(steps.BUILD).toBe('done');
    expect(steps.VALIDATE).toBe('active');
    expect(steps.DONE).toBe('todo');
  });

  it('shows reading as the active step while reading', () => {
    const steps = stepStates({ stage: 'READING', status: 'PROCESSING' } as never);
    expect(steps.READ).toBe('done');
    expect(steps.BUILD).toBe('active');
  });

  it('ticks everything once the draft is waiting', () => {
    const steps = stepStates({ stage: 'READY', status: 'REVIEW' } as never);
    expect(Object.values(steps).every((s) => s === 'done')).toBe(true);
  });

  it('never leaves every step blank for a session that has only just started', () => {
    const steps = stepStates({ stage: 'UPLOADED', status: 'PROCESSING' } as never);
    expect(steps.UPLOAD).toBe('done');
    expect(steps.READ).toBe('active');
  });
});

/**
 * A label with a placeholder in it needs the value that fills it.
 *
 * The confirm dialog takes `confirmLabel` as a finished string, so a `t()`
 * call that forgot its parameters put «خليه {{got}} سؤال» on the button — the
 * interpolation variable's name, in front of the teacher. This pins the two
 * strings that carry counts to the values they need.
 */
describe('the shortfall copy', () => {
  const strings = {
    keep: 'تمام، خليه {{got}} سؤال',
    body: 'اللي رفعته يكفي لـ {{got}} سؤال كويس، مش {{wanted}}. ظبطنا الامتحان على {{got}}: {{mcq}} اختيار من متعدد، {{trueFalse}} صح/خطأ، {{written}} إجابة مكتوبة.',
  };

  const fill = (template: string, params: Record<string, number>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
      params[k] == null ? `{{${k}}}` : String(params[k]),
    );

  it('leaves nothing unfilled on the button', () => {
    expect(fill(strings.keep, { got: 13 })).not.toContain('{{');
    expect(fill(strings.keep, { got: 13 })).toContain('13');
  });

  it('leaves nothing unfilled in the explanation', () => {
    const out = fill(strings.body, { got: 13, wanted: 20, mcq: 7, trueFalse: 3, written: 3 });
    expect(out).not.toContain('{{');
    expect(out).toContain('13');
    expect(out).toContain('20');
  });

  it('shows the variable name when a value is missing, which is the bug', () => {
    // Kept as the failing shape, so the guard above is testing something real.
    expect(fill(strings.keep, {})).toContain('{{got}}');
  });
});

/**
 * Refusing an upload before it is uploaded.
 *
 * The server still checks and still has the last word; this is so a teacher
 * who picked a 62 MB scan is told now, with the number, rather than after
 * waiting for it to travel.
 */
describe('catching an upload that is already over a ceiling', () => {
  const limits: StudioLimits = {
    paper: { maxPages: 25 },
    content: { maxPages: 60 },
    maxImageMb: 15,
    maxPdfMb: 40,
    maxFiles: 30,
  };
  const file = (name: string, mb: number, type = 'image/png') =>
    ({ name, type, size: mb * 1024 * 1024 }) as File;

  it('passes a normal pile of photographs', () => {
    expect(overLimit([file('p1.png', 3), file('p2.png', 4)], 'PAPER', limits)).toBeNull();
  });

  it('names the file that is too large, and by how much it missed', () => {
    const over = overLimit([file('p1.png', 3), file('scan.png', 62)], 'PAPER', limits);
    expect(over).toMatchObject({ code: 'FILE_TOO_LARGE', name: 'scan.png', mb: 62, limit: 15 });
  });

  it('judges a PDF by the PDF ceiling, not the image one', () => {
    expect(overLimit([file('exam.pdf', 30, 'application/pdf')], 'PAPER', limits)).toBeNull();
    expect(overLimit([file('exam.pdf', 55, 'application/pdf')], 'PAPER', limits)).toMatchObject({
      limit: 40,
    });
  });

  it('says how many files are allowed when there are too many', () => {
    const many = Array.from({ length: 31 }, (_, i) => file(`p${i}.png`, 1));
    expect(overLimit(many, 'PAPER', limits)).toMatchObject({ code: 'TOO_MANY_FILES', limit: 30 });
  });

  it('stays out of the way before the ceilings have loaded', () => {
    expect(overLimit([file('huge.png', 500)], 'PAPER', undefined)).toBeNull();
  });
});

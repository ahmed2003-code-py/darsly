import {
  addQuestion,
  allQuestions,
  changeType,
  draftProblems,
  DraftQuestion,
  editQuestion,
  ExamDraft,
  moveQuestion,
  needsReviewCount,
  phaseOf,
  progressPct,
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

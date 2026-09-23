import { aggregatePages, pageProblem, PageExtraction } from './extraction.schema';

const page = (over: Partial<PageExtraction> = {}): PageExtraction => ({
  examTitle: '',
  instructions: [],
  sectionTitle: '',
  blank: false,
  questions: [],
  ...over,
});

const question = (over: Partial<PageExtraction['questions'][0]> = {}) => ({
  number: 1,
  type: 'MCQ' as const,
  text: 'What is the capital of Egypt?',
  options: [
    { label: 'A', text: 'Cairo', correct: false },
    { label: 'B', text: 'Alexandria', correct: false },
  ],
  modelAnswer: '',
  marks: null,
  unsupportedKind: '',
  continuedFromPrevious: false,
  lowConfidence: false,
  ...over,
});

/**
 * The escalation signal.
 *
 * This is the whole cost story in one function: every page it passes is a page
 * the expensive model never sees. So the tests care as much about what it does
 * NOT flag as about what it does — a false alarm here is a bill.
 */
describe('deciding whether a page was read well enough', () => {
  it('keeps a clean page', () => {
    expect(pageProblem(page({ questions: [question()] }))).toBeNull();
  });

  it('keeps a blank page, because "nothing here" is a correct answer', () => {
    expect(pageProblem(page({ blank: true }))).toBeNull();
  });

  it('escalates a page that came back with no questions at all', () => {
    expect(pageProblem(page())).toBe('EMPTY');
  });

  it('believes the model when it says it could not read a question', () => {
    expect(pageProblem(page({ questions: [question({ lowConfidence: true })] }))).toBe(
      'LOW_CONFIDENCE',
    );
  });

  it('escalates a multiple choice question with one option', () => {
    const q = question({ options: [{ label: 'A', text: 'Cairo', correct: false }] });
    expect(pageProblem(page({ questions: [q] }))).toBe('BAD_OPTIONS');
  });

  it('escalates a question whose text is a fragment', () => {
    expect(pageProblem(page({ questions: [question({ text: '3.' })] }))).toBe('EMPTY_TEXT');
  });

  it('escalates nothing at all', () => {
    expect(pageProblem(null)).toBe('INVALID');
  });

  it('does not escalate an Arabic page — the check is about shape, not script', () => {
    const q = question({
      text: 'ما هي عاصمة مصر؟',
      options: [
        { label: 'أ', text: 'القاهرة', correct: true },
        { label: 'ب', text: 'الإسكندرية', correct: false },
      ],
    });
    expect(pageProblem(page({ questions: [q] }))).toBeNull();
  });

  it('does not escalate a written question for having no options', () => {
    const q = question({ type: 'SHORT_ANSWER', options: [], text: 'Explain photosynthesis.' });
    expect(pageProblem(page({ questions: [q] }))).toBeNull();
  });
});

describe('stitching the pages into one exam', () => {
  it('numbers every question across pages, in page order', () => {
    const { draft } = aggregatePages([
      { pageNumber: 2, extraction: page({ questions: [question({ text: 'Second page Q' })] }) },
      { pageNumber: 1, extraction: page({ questions: [question({ text: 'First page Q' })] }) },
    ]);
    const all = draft.sections.flatMap((s) => s.questions);
    expect(all.map((q) => q.text)).toEqual(['First page Q', 'Second page Q']);
    expect(all.map((q) => q.number)).toEqual([1, 2]);
  });

  it('joins a question that ran over the page break instead of keeping both halves', () => {
    const { draft } = aggregatePages([
      { pageNumber: 1, extraction: page({ questions: [question({ text: 'Name the three' })] }) },
      {
        pageNumber: 2,
        extraction: page({
          questions: [question({ text: 'states of matter.', continuedFromPrevious: true })],
        }),
      },
    ]);
    const all = draft.sections.flatMap((s) => s.questions);
    expect(all).toHaveLength(1);
    expect(all[0].text).toBe('Name the three states of matter.');
    expect(all[0].sourcePages).toEqual([1, 2]);
  });

  it('keeps sections apart and takes the title off whichever page carries it', () => {
    const { draft } = aggregatePages([
      {
        pageNumber: 1,
        extraction: page({
          examTitle: 'Physics — Final',
          instructions: ['Answer all questions'],
          sectionTitle: 'Section A',
          questions: [question()],
        }),
      },
      {
        pageNumber: 2,
        extraction: page({ sectionTitle: 'Section B', questions: [question({ text: 'Another' })] }),
      },
    ]);
    expect(draft.title).toBe('Physics — Final');
    expect(draft.instructions).toEqual(['Answer all questions']);
    expect(draft.sections.map((s) => s.title)).toEqual(['Section A', 'Section B']);
  });

  it('tells the teacher about a page that could not be read, rather than losing it silently', () => {
    const { warnings } = aggregatePages([
      { pageNumber: 1, extraction: page({ questions: [question()] }) },
      { pageNumber: 2, extraction: null, failed: true },
    ]);
    expect(warnings.find((w) => w.code === 'PAGE_FAILED')?.page).toBe(2);
  });

  it('surfaces an unsupported question instead of converting it', () => {
    const { draft, warnings } = aggregatePages([
      {
        pageNumber: 1,
        extraction: page({
          questions: [
            question({
              type: 'UNSUPPORTED',
              unsupportedKind: 'matching',
              text: 'Match each country to its capital.',
              options: [],
            }),
          ],
        }),
      },
    ]);
    const q = draft.sections[0].questions[0];
    expect(q.type).toBe('UNSUPPORTED');
    expect(q.needsReview).toBe(true);
    expect(warnings.find((w) => w.code === 'UNSUPPORTED_TYPE')?.detail).toBe('matching');
  });

  it('says so when the paper carried no answer key', () => {
    const { warnings } = aggregatePages([
      { pageNumber: 1, extraction: page({ questions: [question()] }) },
    ]);
    expect(warnings.some((w) => w.code === 'NO_ANSWER_KEY')).toBe(true);
  });

  it('stays quiet about the key when the paper marked its answers', () => {
    const marked = question({
      options: [
        { label: 'A', text: 'Cairo', correct: true },
        { label: 'B', text: 'Alexandria', correct: false },
      ],
    });
    const { warnings } = aggregatePages([
      { pageNumber: 1, extraction: page({ questions: [marked] }) },
    ]);
    expect(warnings.some((w) => w.code === 'NO_ANSWER_KEY')).toBe(false);
  });

  it('notices a missing page from the numbers the paper prints', () => {
    const numbered = (n: number) => question({ number: n, text: `Question number ${n} here` });
    const { warnings } = aggregatePages([
      {
        pageNumber: 1,
        extraction: page({ questions: [numbered(1), numbered(2), numbered(3)] }),
      },
      { pageNumber: 2, extraction: page({ questions: [numbered(6)] }) },
    ]);
    expect(warnings.find((w) => w.code === 'NUMBER_GAP')?.detail).toContain('4, 5');
  });

  it('does not call a section that restarts its numbering a missing page', () => {
    const numbered = (n: number) => question({ number: n, text: `Question number ${n} here` });
    const { warnings } = aggregatePages([
      { pageNumber: 1, extraction: page({ questions: [numbered(1), numbered(2), numbered(3)] }) },
      { pageNumber: 2, extraction: page({ questions: [numbered(1), numbered(2)] }) },
    ]);
    expect(warnings.some((w) => w.code === 'NUMBER_GAP')).toBe(false);
  });

  it('keeps an Arabic question and its English terms exactly as read', () => {
    const q = question({
      text: 'اشرح مفهوم الـ derivative في الرياضيات.',
      type: 'SHORT_ANSWER',
      options: [],
    });
    const { draft } = aggregatePages([{ pageNumber: 1, extraction: page({ questions: [q] }) }]);
    expect(draft.sections[0].questions[0].text).toBe('اشرح مفهوم الـ derivative في الرياضيات.');
  });

  it('reports an empty stack rather than producing an empty exam quietly', () => {
    const { draft, warnings } = aggregatePages([
      { pageNumber: 1, extraction: page({ blank: true }) },
    ]);
    expect(draft.sections).toHaveLength(0);
    expect(warnings.some((w) => w.code === 'NO_QUESTIONS')).toBe(true);
    expect(warnings.some((w) => w.code === 'PAGE_BLANK')).toBe(true);
  });
});

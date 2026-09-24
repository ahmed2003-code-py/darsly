import { DraftQuestion } from './extraction.schema';
import { PlannedQuestion } from './exam-spec';
import {
  DUPLICATE_THRESHOLD,
  findDuplicates,
  gradeQuestions,
  questionsNeedingWork,
  similarity,
  GradedQuestion,
} from './question-quality';

const q = (over: Partial<GradedQuestion> = {}): GradedQuestion => ({
  id: 'q1',
  number: 1,
  type: 'MCQ',
  text: 'Which organelle is responsible for producing ATP in the cell?',
  options: [
    { id: 'o1', label: 'A', text: 'Mitochondrion', correct: true },
    { id: 'o2', label: 'B', text: 'Ribosome', correct: false },
  ],
  modelAnswer: '',
  marks: 2,
  sourcePages: [1],
  unsupportedKind: '',
  needsReview: false,
  chunkIndex: 0,
  ...over,
});

const plan = (types: string[]): PlannedQuestion[] =>
  types.map((type, i) => ({ index: i + 1, type: type as never, difficulty: 'MEDIUM', marks: 1 }));

/**
 * The gate a generated exam passes before a teacher is shown it.
 *
 * Deterministic on purpose: a second model call asking a model to mark its own
 * homework costs as much as the generation and agrees with itself. Everything
 * below is a fact about the text.
 */
describe('checking a generated exam before showing it', () => {
  it('passes an exam that is what was asked for', () => {
    const questions = [
      q(),
      q({ id: 'q2', number: 2, text: 'What is the atomic number of carbon?' }),
    ];
    expect(gradeQuestions(questions, plan(['MCQ', 'MCQ']))).toEqual([]);
  });

  it('says so when fewer questions came back than were asked for', () => {
    const findings = gradeQuestions([q()], plan(['MCQ', 'MCQ', 'MCQ']));
    expect(findings.find((f) => f.problem === 'COUNT_SHORT')?.params).toEqual({
      got: 1,
      wanted: 3,
    });
  });

  it('says so when a requested kind is short', () => {
    const findings = gradeQuestions(
      [
        q(),
        q({ id: 'q2', number: 2, text: 'Another distinct question about cellular respiration' }),
      ],
      plan(['MCQ', 'SHORT_ANSWER']),
    );
    expect(findings.some((f) => f.problem === 'TYPE_MISMATCH')).toBe(true);
  });

  it('catches a multiple choice question with nothing to choose from', () => {
    const findings = gradeQuestions([q({ options: [] })]);
    expect(findings.some((f) => f.problem === 'NO_OPTIONS')).toBe(true);
  });

  it('catches a generated question with no answer marked', () => {
    // Unlike a scanned paper, a generated question must carry its own key —
    // nobody else knows what the model meant.
    const findings = gradeQuestions([
      q({
        options: [
          { id: 'o1', label: 'A', text: 'Mitochondrion', correct: false },
          { id: 'o2', label: 'B', text: 'Ribosome', correct: false },
        ],
      }),
    ]);
    expect(findings.some((f) => f.problem === 'NO_KEY')).toBe(true);
  });

  it('catches a written question with no model answer', () => {
    const findings = gradeQuestions([q({ type: 'SHORT_ANSWER', options: [], modelAnswer: '' })]);
    expect(findings.some((f) => f.problem === 'NO_KEY')).toBe(true);
  });

  it('catches the apology the paper path taught us to look for', () => {
    const findings = gradeQuestions([q({ text: '[نص السؤال غير واضح]', options: [] })]);
    expect(findings.some((f) => f.problem === 'PLACEHOLDER')).toBe(true);
  });

  it('catches a question written from nothing when grounding is required', () => {
    const findings = gradeQuestions([q({ chunkIndex: null })], undefined, {
      requireGrounding: true,
    });
    expect(findings.some((f) => f.problem === 'UNGROUNDED')).toBe(true);
  });

  it('does not demand grounding on the paper path', () => {
    expect(gradeQuestions([q({ chunkIndex: null })])).toEqual([]);
  });
});

describe('noticing the same question asked twice', () => {
  it('scores two ways of asking one thing as alike', () => {
    const a = 'Which organelle is responsible for producing ATP in the cell?';
    const b = 'Which organelle produces ATP inside the cell, responsible for energy?';
    expect(similarity(a, b)).toBeGreaterThan(0.6);
  });

  it('scores two genuinely different questions as different', () => {
    const a = 'Which organelle is responsible for producing ATP in the cell?';
    const b = 'Explain how stomata regulate transpiration in a leaf during drought.';
    expect(similarity(a, b)).toBeLessThan(0.3);
  });

  it('treats Arabic spelled two ways as the same question', () => {
    const a = 'ما هي وظيفة الميتوكوندريا في إنتاج الطاقة داخل الخلية؟';
    const b = 'ما هي وظيفة الميتوكوندريا في انتاج الطاقه داخل الخليه؟';
    expect(similarity(a, b)).toBe(1);
  });

  it('reports the later of a duplicate pair, which is the one to rewrite', () => {
    const questions: Pick<DraftQuestion, 'id' | 'text'>[] = [
      { id: 'a', text: 'Which organelle is responsible for producing ATP in the cell?' },
      { id: 'b', text: 'Explain how stomata regulate transpiration during drought conditions.' },
      { id: 'c', text: 'Which organelle produces ATP inside the cell and is responsible for it?' },
    ];
    const dups = findDuplicates(questions);
    expect(dups).toHaveLength(1);
    expect(dups[0].id).toBe('c');
    expect(dups[0].duplicateOfId).toBe('a');
  });

  // Texts below are real, from production GEN_CALL rejection samples
  // (import cmufolxd500186gh04mu6wsan), cut where the log cut them.
  describe('arithmetic questions', () => {
    const PENSION =
      'يزداد معاش موظف كل سنة بمقدار ثابت. كان معاشه ١٢٨ جنيهًا في السنة السادسة، و٢٠٠ جنيه في السنة الحادية عشرة. احسب معاشه ف';
    const MERCHANT =
      'كتب تاجر على بضاعة ثمنًا قدره ٢٨٠٠ فرنك، ثم باعها بخصم ٢٥٪ من الثمن المكتوب، فحقق ربحًا يساوي ٥٪ من ثمن شرائها. كم دفع ل';

    it('does not match an unrelated question on a shared instruction word', () => {
      // Scored 1.0 in production: the only 4-letter word in the first is
      // "قيمة", and the second contains it too.
      const a = 'إذا كان ك = √٦ ÷ (٢ − √٦)، فما قيمة (ك + ٣)²؟';
      const b =
        'في العبارة «ص دالة في س»، تُحدَّد قيمة ص اعتمادًا على س، وليس العكس كما تصف العبارة.';
      expect(similarity(a, b)).toBeLessThan(DUPLICATE_THRESHOLD);
      expect(
        findDuplicates([
          { id: 'b', text: b },
          { id: 'a', text: a },
        ]),
      ).toEqual([]);
    });

    it('does not match two questions on the opening words alone', () => {
      expect(similarity('ما قيمة ٢٥ × ٤؟', 'ما قيمة ١٢ ÷ ٣؟')).toBeLessThan(DUPLICATE_THRESHOLD);
    });

    it('still catches a short question asked twice', () => {
      expect(similarity('ما قيمة ٢٥ × ٤؟', 'احسب ناتج ٢٥ × ٤')).toBeGreaterThanOrEqual(
        DUPLICATE_THRESHOLD,
      );
      expect(similarity('إذا كان ك = √٦، فما قيمة ك²؟', 'إذا كان ك = √٦، فما قيمة ك²؟')).toBe(1);
    });

    it('reads Arabic-Indic and Western digits as the same numbers', () => {
      expect(similarity('احسب ناتج ٢٥ × ٤', 'احسب ناتج 25 × 4')).toBe(1);
    });

    it.each([
      [
        'بلغ معاش موظف ١٢٨ جنيهًا في السنة السادسة و٢٠٠ جنيه في السنة الحادية عشرة، وكان يزداد بمقدار ثابت كل سنة. هل الزيادة الس',
        PENSION,
      ],
      [
        'كتب تاجر على بضاعة ثمنًا قدره ٢٨٠٠ فرنك، ثم باعها بخصم ٢٥٪ من الثمن المكتوب، محققًا ربحًا يساوي ٥٪ من ثمن الشراء. كم فرن',
        MERCHANT,
      ],
      [
        // No word in common but "سبيكة", "تحتوي" and "الكسر" — Arabic
        // inflection — while all four numbers match.
        'تحتوي سبيكة أولى على ٨١٪ ذهب خالص، وثانية على ٥٦٪ ذهب خالص. خُلِط وزنان منهما بنسبة ٢ : ٣ على الترتيب. ما الكسر الذي يمث',
        'خُلِط ٢ كجم من سبيكة تحتوي على ٨١٪ ذهبًا خالصًا مع ٣ كجم من سبيكة تحتوي على ٥٦٪ ذهبًا خالصًا. ما الكسر الذي يمثّل الذهب ',
      ],
    ])('catches the same problem reworded: %s', (a, b) => {
      expect(similarity(a, b)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    });

    it('tells the same problem with different numbers apart', () => {
      const other =
        'كتب تاجر على بضاعة ثمنًا قدره ٣٦٠٠ فرنك، ثم باعها بخصم ٢٠٪ من الثمن المكتوب، فحقق ربحًا يساوي ١٠٪ من ثمن شرائها. كم دفع ل';
      expect(similarity(MERCHANT, other)).toBeLessThan(DUPLICATE_THRESHOLD);
    });

    it('tells two problems on the same operation apart', () => {
      const a =
        'A cluster contains the one-dimensional data points 2, 5, 8, and 9. When its centroid is updated by calculating the mean ';
      const b =
        'A cluster contains the points (1, 2), (4, 8), and (7, 5). If its centroid is updated by calculating the mean of its assi';
      expect(similarity(a, b)).toBeLessThan(DUPLICATE_THRESHOLD);
    });
  });

  it('reports a duplicate as a finding on the exam', () => {
    const questions = [
      q({ id: 'a', number: 1 }),
      q({
        id: 'b',
        number: 2,
        text: 'Which organelle produces ATP inside the cell and is responsible?',
      }),
    ];
    expect(gradeQuestions(questions).some((f) => f.problem === 'DUPLICATE')).toBe(true);
  });
});

describe('deciding what to rewrite', () => {
  it('points at the questions with something wrong and no others', () => {
    const questions = [
      q({ id: 'a', number: 1 }),
      q({ id: 'b', number: 2, text: '[unclear]', options: [] }),
      q({ id: 'c', number: 3, text: 'A perfectly good question about mitosis and its phases' }),
    ];
    const findings = gradeQuestions(questions);
    const needing = questionsNeedingWork(questions, findings);
    expect(needing.map((x) => x.id)).toEqual(['b']);
  });

  it('points at nothing for an exam-wide shortfall — that is answered by generating more', () => {
    const findings = gradeQuestions([q()], plan(['MCQ', 'MCQ', 'MCQ']));
    expect(questionsNeedingWork([q()], findings)).toEqual([]);
  });
});

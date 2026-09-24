import { DraftQuestion } from './extraction.schema';
import { PlannedQuestion } from './exam-spec';
import {
  DUPLICATE_THRESHOLD,
  findDuplicates,
  gradeQuestions,
  questionProblem,
  questionsNeedingWork,
  repeatsPoint,
  similarity,
  unsupportedNumbers,
  variantNumbersProblem,
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

// Real questions from the Luna-first / Sol-first benchmark on import
// cmufjoy7t001414et7nu9v3dz (2026-09-24), written from its revision sheet
// and arithmetic page.
const mcq = (text: string, key: string, others = ['أ', 'ب', 'ج']) => ({
  type: 'MCQ' as const,
  text,
  options: [key, ...others].map((t, i) => ({
    id: String(i),
    label: String(i),
    text: t,
    correct: i === 0,
  })),
  modelAnswer: '',
});
const tf = (text: string, truth = true) => ({
  type: 'TRUE_FALSE' as const,
  text,
  options: [
    { id: 'a', label: 'أ', text: 'صواب', correct: truth },
    { id: 'b', label: 'ب', text: 'خطأ', correct: !truth },
  ],
  modelAnswer: '',
});
const written = (text: string, modelAnswer: string) => ({
  type: 'SHORT_ANSWER' as const,
  text,
  options: [],
  modelAnswer,
});

describe('one learning point asked twice', () => {
  it.each([
    [
      'true/false and multiple choice on the same rule',
      tf('عند نطق الميم المشددة تكون الغنة بمقدار حركتين.'),
      mcq('ما مقدار الغنة عند نطق الميم المشددة بحسب المادة؟', 'حركتان', [
        'حركة واحدة',
        'ثلاث حركات',
      ]),
    ],
    [
      'true/false and multiple choice on the same number',
      tf('ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.'),
      mcq('كم سنة ظل نوح عليه السلام يدعو قومه بحسب المادة؟', '٩٥٠ سنة', ['٩٠٠ سنة', '١٠٠٠ سنة']),
    ],
    [
      'a written question and a multiple choice on the same two facts',
      written(
        'كم عدد آيات سورة الجن، وهل هي سورة مكية أم مدنية؟',
        'عدد آيات سورة الجن ٢٨ آية، وهي سورة مكية.',
      ),
      mcq('أي وصف لسورة الجن يطابق المعلومتين الواردتين في المادة؟', 'سورة مكية، وعدد آياتها ٢٨', [
        'سورة مكية، وعدد آياتها ٢٩',
        'سورة مدنية، وعدد آياتها ٢٨',
      ]),
    ],
    [
      'a written question and a multiple choice on one date and duration',
      written(
        'في أي سنة هجرية تم صلح الحديبية، وكم سنة نص الصلح على وقف الحرب؟',
        'تم صلح الحديبية في السنة السادسة للهجرة، ونص الصلح على وقف الحرب لمدة عشر سنوات.',
      ),
      mcq(
        'أي خيار يجمع بصورة صحيحة بين سنة صلح الحديبية ومدة وقف الحرب المنصوص عليها فيه؟',
        'السنة السادسة للهجرة، ووقف الحرب عشر سنوات',
        ['السنة الثامنة للهجرة، ووقف الحرب سنتين'],
      ),
    ],
    [
      'one question whose wording gives away the answer to another',
      mcq(
        'يتزايد معاش موظف بمقدار ثابت كل سنة. إذا كان معاشه ١٢٨ جنيهًا في السنة السادسة و٢٠٠ جنيه في السنة الحادية عشرة، فما مقدار الزيادة السنوية؟',
        '١٤٫٤ جنيهًا',
        ['١٢ جنيهًا', '١٥ جنيهًا'],
      ),
      mcq(
        'إذا كان معاش موظف في السنة السادسة ١٢٨ جنيهًا، ويزداد كل سنة بمقدار ثابت قدره ١٤٫٤ جنيهًا، فما معاشه في السنة الأولى؟',
        '٥٦ جنيهًا',
        ['٧٠٫٤ جنيهًا', '١١٣٫٦ جنيهًا'],
      ),
    ],
    [
      'a question that asks for three facts and one that asks for one of them',
      written(
        'اذكر عدد مقاتلي المسلمين، وعدد مقاتلي جيش القساسة وحلفائهم الروم، ومدة القتال بينهما كما وردت في النص.',
        'كان عدد المسلمين ثلاثة آلاف مقاتل، وعدد جيش القساسة وحلفائهم الروم مائتي ألف مقاتل، واستمر القتال ستة أيام.',
      ),
      mcq('بحسب المادة، كم بلغ عدد جيش القساسة وحلفائهم الروم؟', 'مئتا ألف مقاتل', [
        'ثلاثة آلاف مقاتل',
        'عشرة آلاف مقاتل',
      ]),
    ],
  ])('%s', (_, a, b) => {
    expect(repeatsPoint(a, b)).toBe(true);
    expect(repeatsPoint(b, a)).toBe(true);
  });

  it.each([
    [
      'how many verses a surah has, and whether it is Meccan',
      mcq('كم عدد آيات سورة الجن؟', '٢٨ آية', ['٢٩ آية', '٢٦ آية']),
      tf('سورة الجن سورة مكية.'),
    ],
    [
      'the year of a treaty, and how long it stopped the war',
      tf('تم صلح الحديبية في السنة السادسة من الهجرة.'),
      tf('نص صلح الحديبية على وقف الحرب لمدة عشر سنوات.'),
    ],
    [
      'the size of an army, and how long the battle lasted',
      mcq('بحسب المادة، كم بلغ عدد جيش القساسة وحلفائهم الروم؟', 'مئتا ألف مقاتل', [
        'ثلاثة آلاف مقاتل',
        'عشرة آلاف مقاتل',
      ]),
      mcq('كم يومًا استمر القتال بين الجيشين بحسب المادة؟', 'ستة أيام', [
        'ثلاثة أيام',
        'عشرة أيام',
      ]),
    ],
    [
      'two facts about one organelle that share an answer',
      mcq('Which organelle produces most of the ATP in a cell?', 'Mitochondria', [
        'Ribosome',
        'Nucleus',
      ]),
      mcq(
        'Which organelle other than the nucleus carries its own DNA in an animal cell?',
        'Mitochondria',
        ['Ribosome', 'Golgi body'],
      ),
    ],
    [
      'two problems on the same page',
      mcq(
        'سبيكتان تحتوي الأولى على ذهب خالص بنسبة ٨١٪ والثانية بنسبة ٩٦٪، وخُلطتا بنسبة وزن ٢ إلى ٣. ما نسبة الذهب الخالص في السبيكة الناتجة؟',
        '٩٠٪',
        ['٨٧٪', '٩١٪'],
      ),
      mcq(
        'اقترض شخص مبلغًا وسدده على ثلاث دفعات سنوية متساوية، مقدار كل دفعة ٩٢٦١ جنيهًا. إذا كان سعر الفائدة المركبة ٥٪ سنويًا، فما المبلغ المقترض؟',
        '٢٥٢٢٠ جنيهًا',
        ['٢٧٧٨٣ جنيهًا', '٢٤٢٦١ جنيهًا'],
      ),
    ],
  ])('keeps apart %s', (_, a, b) => {
    expect(repeatsPoint(a, b)).toBe(false);
    expect(repeatsPoint(b, a)).toBe(false);
  });
});

describe('numbers a question gives that its material does not', () => {
  const ARITHMETIC =
    '(٣) ارتفاع الزئبق في أنبوبة ٩,٢ من السنتيمترات ووزنه ٤,٨١٣ من الجرامات فإذا علم أن وزن السنتيمتر المكعب من الزئبق ١٣,٦ من الجرامات وأن النسبة التقريبية = ٣,١٤ فما طول قطر الأنبوبة إلى أقرب عشر المليمتر\n' +
    '(٥) تاجر ملابس يضع على كل بنطلون ورقة مكتوب عليها الثمن الذي يبيع به ولكنه يتنازل لزبائنه عن ٢٥٪ من ذلك الثمن المكتوب ومع ذلك يكسب ٥٪ من ثمن الشراء. فإذا كان ٢٨٠ قرشاً\n' +
    '(٧) اقترض مبلغ ووزع هو وربحه المركب على ٣ دفعات متساوية في نهاية كل سنة وكان مقدار الدفعة الأخيرة ٩٢٦١ جنيه فإذا علم أن سعر الفائدة ٥٪ سنويا فما المبلغ المقترض';

  it('catches the purchase price Luna made up to finish a problem', () => {
    const invented = mcq(
      'يمنح تاجر الملابس زبائنه خصمًا قدره ٢٥٪ من الثمن المكتوب، ومع ذلك يحقق ربحًا قدره ٥٪ من ثمن الشراء. إذا كان ثمن الشراء ١٠٠ جنيه، فما الثمن المكتوب على البنطلون؟',
      '١٤٠ جنيهًا',
      ['١٣١٫٢٥ جنيهًا', '١٢٥ جنيهًا'],
    );
    expect(unsupportedNumbers(invented, ARITHMETIC)).toEqual([100]);
  });

  it('reads the decimal comma of the material and the decimal point of the question as one', () => {
    const q = mcq(
      'ارتفاع الزئبق في أنبوبة ٩٫٢ سم ووزنه ٤٫٨١٣ جم، وكثافة الزئبق ١٣٫٦ جم/سم³، وπ ≈ ٣٫١٤. ما قطر الأنبوبة لأقرب عُشر المليمتر؟',
      '٢٫٢ مم',
      ['٢٫٠ مم', '٢٫٤ مم'],
    );
    expect(unsupportedNumbers(q, ARITHMETIC)).toEqual([]);
  });

  it('does not read the answer or the options: a worked-out value is not in the material', () => {
    const q = mcq(
      'اقترض شخص مبلغًا وسدده على ثلاث دفعات سنوية متساوية، مقدار كل دفعة ٩٢٦١ جنيهًا. إذا كان سعر الفائدة المركبة ٥٪ سنويًا، فما المبلغ المقترض؟',
      '٢٥٢٢٠ جنيهًا',
      ['٢٧٧٨٣ جنيهًا', '٢٤٢٦١ جنيهًا'],
    );
    expect(unsupportedNumbers(q, ARITHMETIC)).toEqual([]);
  });

  it('lets a true/false keyed false quote a wrong number on purpose', () => {
    expect(unsupportedNumbers(tf('يكسب التاجر ١٥٪ من ثمن الشراء.', false), ARITHMETIC)).toEqual([]);
    expect(unsupportedNumbers(tf('يكسب التاجر ١٥٪ من ثمن الشراء.', true), ARITHMETIC)).toEqual([
      15,
    ]);
  });

  it('allows a number that names a problem or a step, not data', () => {
    const q = written('اذكر ثلاث خطوات لحل المسألة (٥)، مع خصم ٢٥٪ في الخطوة ٢.', 'أولًا…');
    expect(unsupportedNumbers(q, ARITHMETIC)).toEqual([]);
  });

  it('is checked where the caller asks; variants are checked by the run instead', () => {
    const invented = {
      ...mcq('إذا كان ثمن الشراء ١٠٠ جنيه وربح التاجر ٥٪، فما ثمن البيع؟', '١٠٥ جنيهات', [
        '١١٠ جنيهات',
        '٩٥ جنيهًا',
      ]),
      id: 'x',
      number: 1,
      difficulty: 'MEDIUM' as const,
      marks: 1,
      chunkIndex: 0,
    };
    const ctx = { chunkText: ARITHMETIC, anchor: true };
    expect(questionProblem(invented as never, { ...ctx, numbers: true })).toBe(
      'UNSUPPORTED_NUMBER',
    );
    expect(questionProblem(invented as never, ctx)).toBeNull();
  });
});

describe('small numbers and numbers written in words', () => {
  const SHEET =
    '← عدد حبس المسلمين ثلاثة آلاف مقاتل\n' +
    '← عدد جيش القساسة وحلفائهم الروم مائتى ألف مقاتل\n' +
    '← استمر القتال بينهما ستة أيام\n' +
    '- تم صلح الحديبية في السنة السادسة من الهجرة\n' +
    '- لم تنقض قريش صلح الحديبية بعد عامين من عقده في السنة الثامنة من الهجرة';

  it('catches a small number that changes the fact', () => {
    // Six in the material; three here. Small is not the same as harmless.
    expect(unsupportedNumbers(tf('استمر القتال بين الجيشين ٣ أيام.'), SHEET)).toEqual([3]);
  });

  it("reads the material's numbers written in words", () => {
    expect(unsupportedNumbers(tf('استمر القتال بين الجيشين ٦ أيام.'), SHEET)).toEqual([]);
    expect(unsupportedNumbers(tf('كان عدد المسلمين ٣٠٠٠ مقاتل.'), SHEET)).toEqual([]);
    expect(unsupportedNumbers(tf('بلغ جيش الروم وحلفائهم ٢٠٠٠٠٠ مقاتل.'), SHEET)).toEqual([]);
    expect(unsupportedNumbers(tf('تم صلح الحديبية في السنة ٦ من الهجرة.'), SHEET)).toEqual([]);
    expect(unsupportedNumbers(tf('فتحت مكة في السنة ٨ من الهجرة.'), SHEET)).toEqual([]);
  });

  it('still catches a small number used as data in a problem', () => {
    const q = mcq('اشترى تاجر بضاعة وباعها بخصم ٢٥٪، ثم زاد السعر ٣٪. ما نسبة التغير؟', '٢٢٫٧٥٪');
    expect(unsupportedNumbers(q, 'يتنازل التاجر عن ٢٥٪ من الثمن المكتوب')).toEqual([3]);
  });

  it('lets a true/false keyed false quote a wrong small number on purpose', () => {
    expect(unsupportedNumbers(tf('استمر القتال بين الجيشين ٣ أيام.', false), SHEET)).toEqual([]);
  });
});

describe('numbers in a variant', () => {
  const PAGE =
    '(٧) اقترض مبلغ ووزع هو وربحه المركب على ٣ دفعات متساوية في نهاية كل سنة وكان مقدار الدفعة الأخيرة ٩٢٦١ جنيه فإذا علم أن سعر الفائدة ٥٪ سنويا فما المبلغ المقترض\n' +
    '- ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.';
  const loan = mcq(
    'اقترض شخص مبلغًا وسدده على ثلاث دفعات سنوية متساوية، مقدار كل دفعة ٩٢٦١ جنيهًا. إذا كان سعر الفائدة المركبة ٥٪ سنويًا، فما المبلغ المقترض؟',
    '٢٥٢٢٠ جنيهًا',
    ['٢٧٧٨٣ جنيهًا', '٢٤٢٦١ جنيهًا'],
  );

  it('allows new inputs to a worked problem when the answer was worked out again', () => {
    const variant = mcq(
      'اقترض شخص مبلغًا وسدده على دفعتين سنويتين متساويتين، مقدار كل دفعة ٤٤١٠ جنيهات، بفائدة مركبة ٥٪ سنويًا. ما المبلغ المقترض؟',
      '٨٢٠٠ جنيه',
      ['٨٤٠٠ جنيه', '٨٨٢٠ جنيه'],
    );
    expect(variantNumbersProblem(variant, loan, PAGE)).toBe(false);
  });

  it('refuses new inputs with the old answer: it was not worked out again', () => {
    const variant = mcq(
      'اقترض شخص مبلغًا وسدده على ثلاث دفعات سنوية متساوية، مقدار كل دفعة ٨٠٠٠ جنيه، بفائدة مركبة ٥٪ سنويًا. ما المبلغ المقترض؟',
      '٢٥٢٢٠ جنيهًا',
      ['٢٧٧٨٣ جنيهًا', '٢٤٢٦١ جنيهًا'],
    );
    expect(variantNumbersProblem(variant, loan, PAGE)).toBe(true);
  });

  it("refuses a variant that changes a fact's number", () => {
    const original = tf('ظل نوح عليه السلام يدعو قومه لمدة ٩٥٠ سنة.');
    const variant = tf('ظل نوح عليه السلام يدعو قومه أكثر من ٩٠٠ سنة.');
    expect(variantNumbersProblem(variant, original, PAGE)).toBe(true);
    const asked = mcq('إذا دعا نوح قومه ١٠٠٠ سنة، فكم سنة تبقى بعد ٩٥٠ سنة؟', '٥٠ سنة');
    expect(variantNumbersProblem(asked, original, PAGE)).toBe(true);
  });

  it('refuses a new number keyed to something that is not a worked-out number', () => {
    const variant = mcq(
      'اقترض شخص ٢٠٠٠٠ جنيه بفائدة مركبة ٥٪. أي العبارات صحيحة؟',
      'تزيد الدفعة كلما زادت الفائدة',
    );
    expect(variantNumbersProblem(variant, loan, PAGE)).toBe(true);
  });

  it('does not mind a variant that uses only numbers already given, the original answer included', () => {
    const variant = mcq(
      'إذا كان المبلغ المقترض ٢٥٢٢٠ جنيهًا بفائدة مركبة ٥٪ ويسدد على ثلاث دفعات متساوية، فما قيمة الدفعة؟',
      '٩٢٦١ جنيهًا',
    );
    // From the other end: the original's answer, 25220, is now an input.
    expect(variantNumbersProblem(variant, loan, PAGE)).toBe(false);
    const inverse = mcq(
      'اقترض شخص مبلغًا بفائدة مركبة ٥٪ سنويًا، وسدده على ٣ دفعات متساوية قيمة كل منها ٩٢٦١ جنيهًا. كم يدفع إجمالًا؟',
      '٢٧٧٨٣ جنيهًا',
    );
    expect(variantNumbersProblem(inverse, loan, PAGE)).toBe(false);
  });
});

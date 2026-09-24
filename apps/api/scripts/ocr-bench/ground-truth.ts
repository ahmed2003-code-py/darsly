/**
 * What is actually on the three benchmark pages, read by a person.
 *
 * The references are transcribed by eye from the originals. They are the
 * yardstick, not a claim of perfection: where a stroke is genuinely ambiguous
 * on the page (a decimal separator in faded ink, a radical over a 6) the
 * reference says what a careful reader would type, and the score treats it as
 * the answer. Scoring is on normalised text (see reconcile.normalise), so
 * Arabic-Indic vs Western digits and letter-form variants do not count as
 * errors — a digit that CHANGES does.
 *
 * The images themselves are not in the repository; the runner takes their
 * paths. These are one teacher's test pages, not fixtures to ship.
 */

export interface ExpectedQuestion {
  /** The number printed on the page. */
  n: string;
  type: 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  text: string;
  options?: string[];
}

export interface BenchPaper {
  id: string;
  title: string;
  /** Why this page is in the set — what it tests. */
  challenge: string;
  /** Questions a teacher would expect the import to produce. Empty when the
   *  page holds none; the right outcome then is to say so, not to invent. */
  expected: ExpectedQuestion[];
}

export const PAPERS: BenchPaper[] = [
  {
    id: 'p1-islamic-notes',
    title: 'Paper 1 — Islamic studies revision sheet (grade 5)',
    challenge:
      'A low-resolution phone photo (387×516) of dense handwritten REVISION NOTES — statements, not questions. The correct import is "no questions on this page", not a quiz invented from the facts.',
    expected: [],
  },
  {
    id: 'p2-math-notes',
    title: 'Paper 2 — maths notes with worked examples (functions)',
    challenge:
      'Handwritten notes on a ruled page mixing worked solutions with three multiple-choice questions; piecewise functions, exponents, floor brackets, Arabic option letters.',
    expected: [
      {
        n: '2',
        type: 'MCQ',
        text: 'إذا كانت f(x) = { x-4 , x<2 ; x^2+4 , x≥2 } فإن f(2) تساوي',
        options: ['-2', '1', '5', '8'],
      },
      {
        n: '',
        type: 'MCQ',
        text: 'مثال آخر: إذا كانت f(x) = { 4x , 0≤x≤15 ; 60 , 15<x<24 ; -6x+15 , 24≤x≤40 } فإن f(5) تساوي',
        options: ['20', '15', '25', '5'],
      },
      {
        n: '3',
        type: 'MCQ',
        text: 'إذا كانت f(x) = [x] فإن f(-4,6) تساوي',
        options: ['-4', '-5', '4', '4,6'],
      },
    ],
  },
  {
    id: 'p3-arithmetic-1927',
    title: 'Paper 3 — third-year arithmetic exam, 1927',
    challenge:
      'A historical handwritten exam in faded purple ink: seven numbered word problems, some spanning four or five lines, decimal and percentage figures, a fraction, marginal ticks and a teacher’s pencil answers.',
    expected: [
      {
        n: '1',
        type: 'SHORT_ANSWER',
        text: 'يزداد معاش موظف كل سنة زيادة سنوية ثابتة وقد بلغ معاشه ١٢٨ جنيها في السنة السادسة و ٢٠٠ جنيه في السنة الحادية عشرة. والمطلوب معرفة معاشه السنوي في السنة الاولى من خدمته ومعاشه السنوي في السنة الحادية والعشرين',
      },
      {
        n: '2',
        type: 'SHORT_ANSWER',
        text: 'اوجد قيمة الكسر ٦ / ٦ - ٢ الى ٤ أرقام عشرية مضبوطة',
      },
      {
        n: '3',
        type: 'SHORT_ANSWER',
        text: 'ارتفاع الزئبق في انبوبة ٢٫٩ من السنتيمترات ووزنه ٤٫٨١٣ من الجرامات فاذا علم ان وزن السنتيمتر المكعب من الزئبق ١٣٫٦ من الجرامات والنسبة التقريبية = ٣٫١٤ فما طول قطر الانبوبة الى اقرب عشر المليمتر',
      },
      {
        n: '4',
        type: 'SHORT_ANSWER',
        text: 'سبيكتان من الذهب الاولى تحتوي على ذهب خالص مقداره ٨١٪ من وزنها والثانية تحتوي على ذهب خالص مقداره ٩٦٪ من وزنها فاذا خلط منهما مقداران بنسبة ٢ : ٣ فما النسبة للذهب الخالص في السبيكة الثالثة بالنسبة الى وزنها الكلي',
      },
      {
        n: '5',
        type: 'SHORT_ANSWER',
        text: 'تاجر ملابس يضع على كل بدلة ورقة مكتوب عليها الثمن الذي يبيع به ولكنه يتنازل لزبائنه عن ٢٫٥٪ من ذلك الثمن المكتوب ومع ذلك يكسب ٥٪ من ثمن الشراء فما الثمن الاصلي لبدلة كتب عليها ٢٨٠ غرشا',
      },
      {
        n: '6',
        type: 'SHORT_ANSWER',
        text: 'لاحد الاغنياء تجارة لها راس مال ثابت قدره ٧٠٠٠ جنيه فبعد مضي شهرين من التأسيس باع جزءا من التجارة لشخص بمبلغ ٢٢٠٠ جنيه وبعد ٣ أشهر اخرى باع لشخص آخر جزءا آخر بمبلغ ٨٠٠٠ جنيه وبعد ٧ أشهر من التأسيس وجد ان الارباح بلغت ١٩٦٠٠ جنيه فما حصة كل واحد منهم من الربح',
      },
      {
        n: '7',
        type: 'SHORT_ANSWER',
        text: 'اقترض مبلغ ودفع هو وربحه المركب على ٣ دفعات متساوية في ٣ سنوات كل دفعة في نهاية كل سنة وكان مقدار الدفعة الواحدة ٩٢٦١ جنيه فاذا علم ان سعر الربح ٥٪ سنويا فما المبلغ المقترض',
      },
    ],
  },
];

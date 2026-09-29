import { normalizeForCompare } from '../transcription/stt-guards';
import {
  estimateTokens,
  evidenceFound,
  FINAL_SCHEMA,
  forViewers,
  groundSummary,
  splitSections,
  summaryLimits,
  SUMMARY_SCHEMA_VERSION,
} from './grounded-summary';

const TRANSCRIPT = `طيب قبل ما نبدأ، معلومة مهمة: الامتحان يوم الخميس الجاي الساعة عشرة الصبح. لا لا معلش، أنا غلطت، الامتحان يوم السبت مش الخميس، السبت الساعة عشرة.

قانون مساحة الدايرة: المساحة تساوي باي في نق تربيع. والـ accuracy بتاعنا كانت ٩٢٫٥٪ في آخر تجربة.

والواجب: حلوا تمارين صفحة خمسة وأربعين، وتسلموه أول حصة الأسبوع الجاي.`;
const T = normalizeForCompare(TRANSCRIPT);

describe('evidence: exact after normalising only what varies', () => {
  it('finds a verbatim quote despite punctuation, spacing, letter variants and digits', () => {
    expect(evidenceFound('الامتحان يوم السبت مش الخميس، السبت الساعة عشرة', T)).toBe(true);
    expect(evidenceFound('الإمتحان  يوم السبت — مش الخميس!', T)).toBe(true); // إ/ا, dash, spaces
    expect(evidenceFound('المساحه تساوي باي في نق تربيع', T)).toBe(true); // ة/ه
    expect(evidenceFound('الـ ACCURACY بتاعنا كانت 92.5', T)).toBe(true); // Arabic-Indic digits, case
  });

  it('refuses an invented quote, however close in spirit', () => {
    expect(evidenceFound('الامتحان يوم الأحد الساعة عشرة', T)).toBe(false);
    expect(evidenceFound('decision trees are an example of supervised learning', T)).toBe(false);
    expect(evidenceFound('الامتحان يوم السبت الساعة تسعة', T)).toBe(false); // one word changed
  });

  it('refuses a quote too short to prove anything, and non-strings', () => {
    expect(evidenceFound('السبت', T)).toBe(false);
    expect(evidenceFound('يوم السبت', T)).toBe(false);
    expect(evidenceFound(undefined, T)).toBe(false);
    expect(evidenceFound('', T)).toBe(false);
  });

  it('a quote shortened with "…" passes only if every piece is there, in order', () => {
    expect(evidenceFound('حلوا تمارين صفحة خمسة… أول حصة الأسبوع الجاي', T)).toBe(true);
    expect(evidenceFound('أول حصة الأسبوع الجاي… حلوا تمارين صفحة خمسة', T)).toBe(false); // wrong order
    expect(evidenceFound('حلوا تمارين صفحة خمسة… أول حصة الشهر الجاي', T)).toBe(false);
  });
});

describe('grounding a model answer', () => {
  const answer = {
    title: 'مراجعة',
    quickSummary: 'الامتحان يوم السبت.',
    keyPoints: [
      { text: 'الامتحان يوم السبت', evidence: 'الامتحان يوم السبت مش الخميس' },
      {
        text: 'Decision trees مثال على supervised learning',
        evidence: 'decision trees are a classic example',
      },
    ],
    concepts: [],
    examples: [],
    formulas: [
      { formula: 'A = πr²', meaning: 'مساحة الدائرة', evidence: 'المساحة تساوي باي في نق تربيع' },
    ],
    questions: [
      {
        question: 'هو الامتحان open book؟',
        answered: true,
        answer: '',
        evidence: 'الامتحان يوم السبت مش الخميس',
      },
      {
        question: 'سؤال',
        answered: false,
        answer: 'اخترعت إجابة',
        evidence: 'الامتحان يوم السبت مش الخميس',
      },
    ],
    homework: [
      {
        task: 'تمارين صفحة 45',
        due: 'أول حصة الأسبوع الجاي',
        evidence: 'حلوا تمارين صفحة خمسة وأربعين',
      },
      { task: 'مشروع', due: '14 أكتوبر', evidence: 'المشروع تسليمه يوم أربعتاشر أكتوبر' },
    ],
    corrections: [
      { wrong: 'الخميس', corrected: 'السبت', evidence: 'لا لا معلش، أنا غلطت، الامتحان يوم السبت' },
    ],
    reviewPoints: [],
    studyNotes: '…',
  };

  it('drops every item whose evidence is not in the transcript, and counts them', () => {
    const g = groundSummary(answer, TRANSCRIPT);
    expect(g.summary.keyPoints).toHaveLength(1);
    expect(g.summary.homework).toHaveLength(1); // the invented project deadline is gone
    expect(g.summary.formulas).toHaveLength(1);
    expect(g.summary.corrections[0]).toMatchObject({ corrected: 'السبت' });
    expect(g.dropped).toEqual({ keyPoints: 1, homework: 1 });
    expect(g.summary.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION);
  });

  it('never keeps an answer the teacher did not give', () => {
    const q = groundSummary(answer, TRANSCRIPT).summary.questions;
    expect(q[0]).toMatchObject({ answered: false, answer: null }); // "answered" with no answer
    expect(q[1]).toMatchObject({ answered: false, answer: null }); // unanswered carries no answer
  });

  it('viewers never receive the evidence quotes; an old (v1) summary passes unchanged', () => {
    const shown = forViewers(groundSummary(answer, TRANSCRIPT).summary) as any;
    expect(JSON.stringify(shown)).not.toMatch(/evidence/);
    expect(shown.keyPoints[0]).toEqual({ text: 'الامتحان يوم السبت' });
    const v1 = {
      summary: 's',
      topics: [],
      keyPoints: ['a'],
      questionsAndAnswers: [],
      actionItems: [],
    };
    expect(forViewers(v1)).toBe(v1);
  });

  it('the schema asks for evidence on every factual item, and none on the prose fields', () => {
    for (const f of [
      'keyPoints',
      'concepts',
      'examples',
      'formulas',
      'questions',
      'homework',
      'corrections',
    ]) {
      expect((FINAL_SCHEMA.properties as any)[f].items.required).toContain('evidence');
    }
    expect(FINAL_SCHEMA.required).toEqual(
      expect.arrayContaining(['title', 'quickSummary', 'reviewPoints', 'studyNotes']),
    );
  });
});

describe('sizing: token-aware, never a cut', () => {
  it('estimates on the safe side of the measured 3.04 chars/token', () => {
    const text = 'ا'.repeat(30_400);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(10_000);
  });

  it("a dense 3-hour class (≈141k chars) is one call; the single-call limit is far inside luna's 1.05M context", () => {
    const lim = summaryLimits({});
    expect(estimateTokens('ا'.repeat(141_000))).toBeLessThan(lim.singleCallMaxTokens);
    expect(lim.singleCallMaxTokens + lim.singleCallOutput * 2 + 10_000).toBeLessThan(1_050_000 / 2);
  });

  it('splitting into sections loses nothing and keeps the order', () => {
    const paras = Array.from({ length: 300 }, (_, i) => `فقرة رقم ${i} ` + 'كلام '.repeat(50));
    const text = paras.join('\n\n');
    const parts = splitSections(text, 2_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('\n\n')).toBe(text);
  });

  it('a single paragraph longer than a section is cut at word boundaries, not lost', () => {
    const one = 'كلمة '.repeat(20_000).trim();
    const parts = splitSections(one, 1_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(one);
  });
});

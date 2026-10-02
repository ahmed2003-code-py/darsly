import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * C6 OWNS ONLY PAPER EXAMS, THEIR RESULTS, THEIR REVISIONS AND GRADE SETTINGS.
 *
 * Paper grades live beside online assessments, never inside them: no Quiz,
 * Assignment, Challenge or PaperImport (OCR) row is read or written here, no
 * AI is called, nothing is gamified. The roster is read from C1/C2, never
 * written; attendance, fees and platform money are untouched. This spec keeps
 * that true in the code itself.
 */
const SRC = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
const lines = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));

const OTHERS =
  'academyStudent|studentProfile|user|groupMembership|group|groupAssignment|groupSession|attendanceSession|attendanceRecord|academyStudentCard|guardian|guardianLink|studentFollowUp|studentContact|academySubject';
const WRITE = new RegExp(
  `\\.(${OTHERS})\\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\\b|\\b(INSERT INTO|UPDATE|DELETE FROM) "(AcademyStudent|StudentProfile|User|GroupMembership|Group|GroupAssignment|GroupSession|AttendanceSession|AttendanceRecord|AcademyStudentCard|Guardian|GuardianLink|StudentFollowUp|StudentContact|AcademySubject)"`,
);
const ONLINE =
  /\.(quiz|quizQuestion|quizAttempt|assignment|assignmentSubmission|challenge|challengeAttempt|paperImport)\b|"(Quiz|QuizQuestion|QuizAttempt|Assignment|AssignmentSubmission|Challenge|ChallengeAttempt|PaperImport)"|from '\.\.\/(assessments|challenges|paper-import|ai|ocr|gamification)/;
const C4_MODELS =
  /\.(centerFeePlan|centerCharge|centerAdjustment|centerCollection|centerAllocation|centerReceiptCounter)\b|"Center(FeePlan|Charge|Adjustment|Collection|Allocation|ReceiptCounter|ChargeBalance)"/;
const PLATFORM =
  /\.(payment|paymentEvent|ledgerTransaction|ledgerEntry|walletTransaction|walletTopup|payoutRequest|livePurchase|commercialTerms)\b|"(Payment|PaymentEvent|LedgerTransaction|LedgerEntry|WalletTransaction|WalletTopup|PayoutRequest|LivePurchase|CommercialTerms)"|from '\.\.\/(payments|wallet|payouts|live\/commerce)/;
const AI = /openai|anthropic|gemini|from '\.\.\/(ai|llm|ocr)/i;

describe('C6 boundary', () => {
  const mine = files(join(SRC, 'paper-exams'));
  const offenders = (re: RegExp, set = mine) =>
    set.flatMap((f) =>
      lines(f)
        .filter(({ line }) => re.test(line))
        .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
    );

  it('paper exams write nothing other phases own (register, groups, classes, attendance, cards, guardians, follow-up)', () => {
    expect(offenders(WRITE)).toEqual([]);
  });

  it('paper exams never touch online assessments, OCR imports, AI or gamification', () => {
    expect(offenders(ONLINE)).toEqual([]);
    expect(offenders(AI)).toEqual([]);
  });

  it('paper exams never touch fees or platform money', () => {
    expect(offenders(C4_MODELS)).toEqual([]);
    expect(offenders(PLATFORM)).toEqual([]);
  });

  it('nothing outside paper-exams writes an exam, a result, a revision or grade settings', () => {
    const others = files(SRC).filter((f) => !relative(SRC, f).startsWith('paper-exams'));
    expect(
      offenders(
        /\.(paperExam|paperExamResult|paperExamRevision|academyGradeSettings)\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM) "(PaperExam|PaperExamResult|PaperExamRevision|AcademyGradeSettings)"/,
        others,
      ),
    ).toEqual([]);
  });

  it('online assessments, OCR and gamification never read paper grades', () => {
    const online = files(SRC).filter((f) =>
      /^(assessments|challenges|paper-import|gamification|ai)[\\/]/.test(relative(SRC, f)),
    );
    expect(
      offenders(/\.(paperExam|paperExamResult|paperExamRevision)\b|"PaperExam/, online),
    ).toEqual([]);
  });
});

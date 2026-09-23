import { api } from './api';

/**
 * The client half of paper exam import.
 *
 * Everything in here that is not an HTTP call is a pure function, so the state
 * the screen moves through can be tested without rendering anything. The
 * screen itself then has no logic worth testing left in it — which is the
 * point of the split, not a side effect of it.
 */

export type ImportStatus =
  'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'COMPLETED' | 'FAILED' | 'CANCELED';

export type DraftType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'UNSUPPORTED';

export interface DraftOption {
  id: string;
  label: string;
  text: string;
  correct: boolean;
}

export interface DraftQuestion {
  id: string;
  number: number;
  type: DraftType;
  text: string;
  options: DraftOption[];
  modelAnswer: string;
  marks: number | null;
  sourcePages: number[];
  unsupportedKind: string;
  needsReview: boolean;
}

export interface DraftSection {
  title: string;
  questions: DraftQuestion[];
}

export interface ExamDraft {
  title: string;
  instructions: string[];
  sections: DraftSection[];
}

export interface DraftWarning {
  code: string;
  detail: string;
  page?: number;
}

export interface ImportPage {
  id: string;
  pageNumber: number;
  status: 'PENDING' | 'EXTRACTED' | 'ESCALATED' | 'FAILED' | 'SKIPPED';
  model: string | null;
  escalationReason: string | null;
  error: string | null;
}

export interface PaperImport {
  id: string;
  status: ImportStatus;
  title: string;
  sourceKind: 'IMAGES' | 'PDF';
  error: string | null;
  lessonId: string | null;
  courseId: string | null;
  draft: ExamDraft;
  warnings: DraftWarning[];
  pages: ImportPage[];
  progress: { done: number; total: number };
}

/**
 * What the screen is doing right now.
 *
 * Derived from the server's own state rather than tracked alongside it, so a
 * reload lands the teacher exactly where they were and two tabs cannot
 * disagree about what stage an import is at.
 */
export type Phase = 'upload' | 'processing' | 'review' | 'done' | 'failed';

export function phaseOf(record: Pick<PaperImport, 'status'> | null | undefined): Phase {
  if (!record) return 'upload';
  switch (record.status) {
    case 'UPLOADING':
    case 'PROCESSING':
      return 'processing';
    case 'REVIEW':
      return 'review';
    case 'COMPLETED':
      return 'done';
    default:
      return 'failed';
  }
}

/**
 * How far along, as a percentage — counted from pages that have actually come
 * back, never from a timer. A bar that moves while nothing is happening is a
 * lie, and the one thing a teacher watching a slow import must be able to
 * trust is that it is still moving.
 */
export function progressPct(record: Pick<PaperImport, 'progress'> | null | undefined): number {
  const total = record?.progress?.total ?? 0;
  if (!total) return 0;
  return Math.round((record!.progress.done / total) * 100);
}

/** Every question, in order, across sections. The review screen is one list. */
export function allQuestions(draft: ExamDraft | null | undefined): DraftQuestion[] {
  return (draft?.sections ?? []).flatMap((s) => s.questions);
}

/** Questions the teacher must look at before confirming. */
export function needsReviewCount(draft: ExamDraft | null | undefined): number {
  return allQuestions(draft).filter((q) => q.needsReview).length;
}

export function unsupportedCount(draft: ExamDraft | null | undefined): number {
  return allQuestions(draft).filter((q) => q.type === 'UNSUPPORTED').length;
}

/**
 * Is this draft ready to become an exam?
 *
 * Deliberately not "does it have questions". A multiple-choice question with
 * no answer marked is a question every student gets wrong, so the check is the
 * one the teacher would make themselves.
 */
export function draftProblems(draft: ExamDraft | null | undefined): string[] {
  const questions = allQuestions(draft);
  const problems: string[] = [];
  if (!questions.length) problems.push('EMPTY');
  if (questions.some((q) => !q.text.trim())) problems.push('BLANK_TEXT');
  if (
    questions.some(
      (q) => (q.type === 'MCQ' || q.type === 'TRUE_FALSE') && !q.options.some((o) => o.correct),
    )
  ) {
    problems.push('NO_CORRECT_OPTION');
  }
  if (
    questions.some(
      (q) =>
        (q.type === 'MCQ' || q.type === 'TRUE_FALSE') &&
        q.options.filter((o) => o.text.trim()).length < 2,
    )
  ) {
    problems.push('TOO_FEW_OPTIONS');
  }
  return problems;
}

// ── editing ──────────────────────────────────────────────────────────────
//
// The draft is edited immutably and saved whole, the same way the quiz
// builder owns its question set. Each of these takes a draft and returns a new
// one, which is what makes them worth testing on their own.

function mapQuestions(
  draft: ExamDraft,
  fn: (questions: DraftQuestion[]) => DraftQuestion[],
): ExamDraft {
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, questions: fn(s.questions) })) };
}

export function editQuestion(
  draft: ExamDraft,
  id: string,
  patch: Partial<DraftQuestion>,
): ExamDraft {
  return mapQuestions(draft, (qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
}

/**
 * Change a question's type.
 *
 * Not a field assignment: true/false needs two options and a written question
 * needs none, so switching without fixing the options leaves a question that
 * cannot be saved. Changing type is also how a teacher rescues an unsupported
 * question, which is the main reason this exists.
 */
export function changeType(draft: ExamDraft, id: string, type: DraftType): ExamDraft {
  return mapQuestions(draft, (qs) =>
    qs.map((q) => {
      if (q.id !== id) return q;
      if (type === 'SHORT_ANSWER') {
        return { ...q, type, options: [], needsReview: false, unsupportedKind: '' };
      }
      if (type === 'TRUE_FALSE') {
        const [a, b] = q.options;
        return {
          ...q,
          type,
          options: [
            { id: a?.id ?? `${q.id}-t`, label: '', text: a?.text || 'True', correct: !!a?.correct },
            {
              id: b?.id ?? `${q.id}-f`,
              label: '',
              text: b?.text || 'False',
              correct: !!b?.correct,
            },
          ],
          needsReview: false,
          unsupportedKind: '',
        };
      }
      const options = q.options.length
        ? q.options
        : [1, 2, 3, 4].map((n) => ({ id: `${q.id}-o${n}`, label: '', text: '', correct: false }));
      return { ...q, type, options, needsReview: false, unsupportedKind: '' };
    }),
  );
}

/** Mark an option right. One answer replaces the previous one; `multi` adds to
 *  it, because "choose two" is a real question a paper asks. */
export function setCorrect(
  draft: ExamDraft,
  questionId: string,
  optionId: string,
  multi = false,
): ExamDraft {
  return mapQuestions(draft, (qs) =>
    qs.map((q) => {
      if (q.id !== questionId) return q;
      return {
        ...q,
        options: q.options.map((o) => ({
          ...o,
          correct: o.id === optionId ? (multi ? !o.correct : true) : multi ? o.correct : false,
        })),
        // Choosing an answer is the teacher having looked at it.
        needsReview: false,
      };
    }),
  );
}

export function removeQuestion(draft: ExamDraft, id: string): ExamDraft {
  return renumber(mapQuestions(draft, (qs) => qs.filter((q) => q.id !== id)));
}

/** Move a question one place up or down within its own section. */
export function moveQuestion(draft: ExamDraft, id: string, delta: -1 | 1): ExamDraft {
  return renumber(
    mapQuestions(draft, (qs) => {
      const from = qs.findIndex((q) => q.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= qs.length) return qs;
      const next = [...qs];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    }),
  );
}

/** A question the paper had and the extraction missed. */
export function addQuestion(draft: ExamDraft, sectionIndex = 0): ExamDraft {
  const id = `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const question: DraftQuestion = {
    id,
    number: allQuestions(draft).length + 1,
    type: 'MCQ',
    text: '',
    options: [1, 2, 3, 4].map((n) => ({ id: `${id}-o${n}`, label: '', text: '', correct: false })),
    modelAnswer: '',
    marks: null,
    sourcePages: [],
    unsupportedKind: '',
    needsReview: false,
  };
  const sections = draft.sections.length
    ? draft.sections.map((s, i) =>
        i === sectionIndex ? { ...s, questions: [...s.questions, question] } : s,
      )
    : [{ title: '', questions: [question] }];
  return renumber({ ...draft, sections });
}

/** Numbering is the paper's, until the teacher edits it — then it is ours, and
 *  it has to stay consecutive across sections or the exam reads wrong. */
export function renumber(draft: ExamDraft): ExamDraft {
  let n = 0;
  return {
    ...draft,
    sections: draft.sections.map((s) => ({
      ...s,
      questions: s.questions.map((q) => ({ ...q, number: ++n })),
    })),
  };
}

// ── api ──────────────────────────────────────────────────────────────────

export async function uploadPaper(files: File[]): Promise<{ id: string }> {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  const { data } = await api.post('/teacher/paper-imports', body);
  return data;
}

export async function fetchImport(id: string): Promise<PaperImport> {
  const { data } = await api.get(`/teacher/paper-imports/${id}`);
  return data;
}

export async function listImports(): Promise<
  (Pick<PaperImport, 'id' | 'status' | 'title' | 'sourceKind' | 'lessonId' | 'courseId'> & {
    costCents: number;
    createdAt: string;
    _count: { pages: number };
  })[]
> {
  const { data } = await api.get('/teacher/paper-imports');
  return data;
}

export async function saveDraft(id: string, draft: ExamDraft): Promise<void> {
  await api.put(`/teacher/paper-imports/${id}/draft`, draft);
}

export async function retryImport(id: string): Promise<void> {
  await api.post(`/teacher/paper-imports/${id}/retry`);
}

export async function confirmImport(
  id: string,
  body: {
    target: 'NEW_COURSE' | 'EXISTING_COURSE';
    courseId?: string;
    title?: string;
    setAsCourseExam?: boolean;
    examMode?: 'GATE' | 'FINAL';
    dropUnsupported?: boolean;
  },
): Promise<{ courseId: string; lessonId: string; questionCount: number }> {
  const { data } = await api.post(`/teacher/paper-imports/${id}/confirm`, body);
  return data;
}

export async function deleteImport(id: string): Promise<void> {
  await api.delete(`/teacher/paper-imports/${id}`);
}

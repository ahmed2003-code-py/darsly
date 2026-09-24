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
  | 'UPLOADING'
  | 'PROCESSING'
  /// Content path: the material has been read and the teacher has not yet
  /// said what exam they want out of it.
  | 'CONFIGURING'
  | 'REVIEW'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED';

/** Which way into the studio this session took. */
export type CreationKind = 'PAPER' | 'CONTENT';

/** Where the worker is. Stored on the server, so a reload shows the truth. */
export type CreationStage = 'UPLOADED' | 'READING' | 'GENERATING' | 'VALIDATING' | 'READY';

export type SpecQuestionType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';

/** What the teacher asked for, on the content path. */
export interface ExamSpec {
  questionCount: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'MIXED';
  mix: { EASY: number; MEDIUM: number; HARD: number };
  types: Record<SpecQuestionType, number>;
  title: string;
  instructions: string[];
  marksPerQuestion: number | null;
  timeLimitMin: number | null;
  language: 'AUTO' | 'AR' | 'EN';
  shuffle: boolean;
  showAnswers: boolean;
}

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
  /** Written by varying a question the material did support, to reach the
   *  number the teacher asked for. Shown on the review screen, because
   *  "which of these are variants" is a fair question to want answered. */
  variant?: boolean;
  options: DraftOption[];
  modelAnswer: string;
  marks: number | null;
  sourcePages: number[];
  /** Content path: which chunk of the uploaded material this came from, and
   *  which file — "biology.pdf — صفحة 8" on the review screen. */
  sourceChunk?: number | null;
  sourceFile?: string;
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
  /** Values the sentence needs. The sentence itself is composed here, in the
   *  reader's language — the server does not know what that is. */
  params?: Record<string, string | number>;
  /** Readable fallback for a warning this build has no wording for yet. */
  detail: string;
  page?: number;
}

/** The i18n key for a warning, or null when this build does not know it and
 *  should show the server's fallback text instead of an empty line. */
export function warningKey(code: string): string | null {
  const known = [
    'PAGE_FAILED',
    'PAGE_PROVIDER_ERROR',
    'PAGE_OUTPUT_INVALID',
    'PAGE_BLANK',
    'UNSUPPORTED_TYPE',
    'LOW_CONFIDENCE',
    'NOT_READ',
    'NO_ANSWER_KEY',
    'NUMBER_GAP',
    'NO_QUESTIONS',
    'NOT_ENOUGH_CONTENT',
    'GENERATION_INCOMPLETE',
    'COMPLETED_WITH_VARIANTS',
    'DUPLICATE_QUESTION',
  ];
  return known.includes(code) ? `paper.warn.${code}` : null;
}

export interface ImportPage {
  id: string;
  pageNumber: number;
  status: 'PENDING' | 'EXTRACTED' | 'ESCALATED' | 'FAILED' | 'SKIPPED';
  model: string | null;
  escalationReason: string | null;
  error: string | null;
  /** What the worker is doing to this page right now; null before and after. */
  phase?: PagePhase | null;
  phaseDone?: number | null;
  phaseTotal?: number | null;
}

export type PagePhase =
  'PREPARING' | 'READING' | 'LOCATING' | 'REREADING' | 'CHECKING_NUMBERS' | 'SHAPING';

/**
 * The page being worked on this second, and what is being done to it — the
 * worker's own report, written as each step starts. Null when no page is mid-
 * read (between pages, or on the text-only path), and the screen then says
 * only what the counts say.
 */
export function livePage(
  record: Pick<PaperImport, 'pages'> | null | undefined,
): { pageNumber: number; phase: PagePhase; done: number; total: number } | null {
  const page = record?.pages.find((p) => p.phase);
  if (!page?.phase) return null;
  return {
    pageNumber: page.pageNumber,
    phase: page.phase,
    done: page.phaseDone ?? 0,
    total: page.phaseTotal ?? 0,
  };
}

export interface PaperImport {
  id: string;
  kind: CreationKind;
  status: ImportStatus;
  stage: CreationStage;
  title: string;
  sourceKind: 'IMAGES' | 'PDF' | 'MIXED';
  error: string | null;
  lessonId: string | null;
  courseId: string | null;
  draft: ExamDraft;
  spec: ExamSpec;
  warnings: DraftWarning[];
  pages: ImportPage[];
  progress: { done: number; total: number };
  highAccuracy: boolean;
  costCents: number;
  generationBatches: number;
}

/**
 * What the screen is doing right now.
 *
 * Derived from the server's own state rather than tracked alongside it, so a
 * reload lands the teacher exactly where they were and two tabs cannot
 * disagree about what stage an import is at.
 */
export type Phase = 'upload' | 'processing' | 'configuring' | 'review' | 'done' | 'failed';

export function phaseOf(record: Pick<PaperImport, 'status'> | null | undefined): Phase {
  if (!record) return 'upload';
  switch (record.status) {
    case 'UPLOADING':
    case 'PROCESSING':
      return 'processing';
    case 'CONFIGURING':
      return 'configuring';
    case 'REVIEW':
      return 'review';
    case 'COMPLETED':
      return 'done';
    default:
      return 'failed';
  }
}

/**
 * The state a teacher is told they are in.
 *
 * Six of them, all derived from what the server actually recorded — there is
 * no state kept in the browser that could disagree with the work, and a
 * reload lands on the truth. `RETRYING` and `HIGH_ACCURACY` exist separately
 * from `PROCESSING` because "we are reading this again, more slowly" is a
 * different thing to be told than "we are reading this", and showing the same
 * spinner for both is how a screen comes to look frozen.
 */
export type CreationState =
  | 'PROCESSING'
  | 'RETRYING'
  | 'HIGH_ACCURACY'
  | 'NEEDS_SPEC'
  | 'READY'
  | 'NEEDS_REVIEW'
  | 'HIGH_ACCURACY_AVAILABLE'
  | 'FAILED'
  | 'DONE';

export function creationState(record: PaperImport | null | undefined): CreationState {
  if (!record) return 'PROCESSING';
  switch (record.status) {
    case 'UPLOADING':
    case 'PROCESSING':
      if (record.highAccuracy) return 'HIGH_ACCURACY';
      // A page that has been attempted before and is being attempted again.
      return record.pages.some((p) => p.status === 'FAILED') ? 'RETRYING' : 'PROCESSING';
    case 'CONFIGURING':
      return 'NEEDS_SPEC';
    case 'REVIEW':
      if (looksUnreadable(record.draft)) return 'HIGH_ACCURACY_AVAILABLE';
      return record.warnings.length || needsReviewCount(record.draft) ? 'NEEDS_REVIEW' : 'READY';
    case 'COMPLETED':
      return 'DONE';
    default:
      return 'FAILED';
  }
}

/**
 * The five steps of the pipeline, and where this session is in them.
 *
 * Read from the server's own `stage`, so a tick beside "قراءة الصفحات" means
 * the worker finished reading, not that a timer elapsed.
 */
export const CREATION_STEPS = ['UPLOAD', 'READ', 'BUILD', 'VALIDATE', 'DONE'] as const;
export type CreationStep = (typeof CREATION_STEPS)[number];

export function stepStates(
  record: Pick<PaperImport, 'stage' | 'status'> | null | undefined,
): Record<CreationStep, 'done' | 'active' | 'todo'> {
  const order: Record<CreationStage, number> = {
    UPLOADED: 0,
    READING: 1,
    GENERATING: 2,
    VALIDATING: 3,
    READY: 4,
  };
  const at = order[record?.stage ?? 'UPLOADED'];
  const finished = record?.status === 'REVIEW' || record?.status === 'COMPLETED';
  const out = {} as Record<CreationStep, 'done' | 'active' | 'todo'>;
  CREATION_STEPS.forEach((step, i) => {
    // Uploading is always behind us by the time a session exists at all.
    if (i === 0) out[step] = 'done';
    else if (finished) out[step] = 'done';
    else if (i < at + 1) out[step] = 'done';
    else if (i === at + 1) out[step] = 'active';
    else out[step] = 'todo';
  });
  return out;
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

export async function uploadPaper(
  files: File[],
  kind: CreationKind = 'PAPER',
  onProgress?: (pct: number) => void,
): Promise<{ id: string }> {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  body.append('kind', kind);
  const { data } = await api.post('/teacher/paper-imports', body, {
    // Real upload progress: the browser's own count of bytes on the wire.
    onUploadProgress: (e) => {
      if (!onProgress || !e.total) return;
      onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
}

/** Say what exam to write, and start writing it. */
export async function setSpec(id: string, spec: ExamSpec): Promise<void> {
  await api.put(`/teacher/paper-imports/${id}/spec`, spec);
}

/** Write one question again — only that one. */
export async function regenerateQuestion(
  id: string,
  questionId: string,
  reason?: string,
): Promise<{ question: DraftQuestion }> {
  const { data } = await api.post(
    `/teacher/paper-imports/${id}/questions/${questionId}/regenerate`,
    { reason },
  );
  return data;
}

/** Stop work that has not happened yet. The uploads stay. */
export async function cancelImport(id: string): Promise<void> {
  await api.post(`/teacher/paper-imports/${id}/cancel`);
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

/**
 * Read the pages again.
 *
 * `escalate` is the teacher saying the result was not good enough — old
 * handwriting read as five identical questions, say. It re-reads the whole
 * paper on the strongest model and replaces the draft, which is why it is a
 * separate, named request and not something that happens on its own.
 */
export async function retryImport(id: string, escalate = false): Promise<void> {
  await api.post(`/teacher/paper-imports/${id}/retry`, { escalate });
}

/**
 * Did this import come back readable?
 *
 * The question the "read it again more carefully" button asks. A draft where
 * most questions are flagged, or where the same text appears more than once,
 * is a draft nobody should be editing question by question — it is a paper the
 * cheap model could not read.
 */
export function looksUnreadable(draft: ExamDraft | null | undefined): boolean {
  const questions = allQuestions(draft);
  if (!questions.length) return false;
  const texts = questions.map((q) => q.text.trim()).filter(Boolean);
  if (texts.length > 1 && new Set(texts).size < texts.length) return true;
  return needsReviewCount(draft) / questions.length >= 0.5;
}

export async function confirmImport(
  id: string,
  body: {
    target: 'NEW_COURSE' | 'EXISTING_COURSE';
    courseId?: string;
    title?: string;
    /** The one school year a new exam course is for — required for NEW_COURSE. */
    gradeId?: string;
    subjectId?: string;
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

/** The ceilings on an upload, so a screen can say them before a teacher picks
 *  forty files rather than after. */
export interface StudioLimits {
  paper: { maxPages: number };
  content: { maxPages: number };
  maxImageMb: number;
  maxPdfMb: number;
  maxFiles: number;
}

export async function fetchLimits(): Promise<StudioLimits> {
  const { data } = await api.get('/teacher/paper-imports/limits');
  return data;
}

/**
 * Is this pile of files already over a ceiling?
 *
 * Checked in the browser too, so a teacher who picked one file too many is
 * told before the upload rather than after it — the server still checks, and
 * still has the last word.
 */
export function overLimit(
  files: File[],
  kind: CreationKind,
  limits: StudioLimits | undefined,
): { code: 'TOO_MANY_FILES' | 'FILE_TOO_LARGE'; name?: string; mb?: number; limit: number } | null {
  if (!limits) return null;
  if (files.length > limits.maxFiles) {
    return { code: 'TOO_MANY_FILES', limit: limits.maxFiles };
  }
  for (const file of files) {
    const isPdf = file.type === 'application/pdf';
    const cap = isPdf ? limits.maxPdfMb : limits.maxImageMb;
    if (file.size > cap * 1024 * 1024) {
      return {
        code: 'FILE_TOO_LARGE',
        name: file.name,
        mb: Math.round(file.size / 1024 / 1024),
        limit: cap,
      };
    }
  }
  // Pages inside a PDF cannot be counted here; the server does that.
  void kind;
  return null;
}

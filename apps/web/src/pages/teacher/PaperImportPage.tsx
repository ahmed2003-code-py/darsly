import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, ErrorNote, Field, PageHeader, ProgressBar, Spinner } from '../../components/ui';
import {
  addQuestion,
  allQuestions,
  changeType,
  confirmImport,
  DraftQuestion,
  DraftType,
  draftProblems,
  editQuestion,
  ExamDraft,
  fetchImport,
  looksUnreadable,
  moveQuestion,
  phaseOf,
  progressPct,
  removeQuestion,
  retryImport,
  saveDraft,
  setCorrect,
  unsupportedCount,
  uploadPaper,
  warningKey,
} from '../../lib/paperImport';

/**
 * Paper exam import, end to end: upload, watch, review, confirm.
 *
 * The screen has four faces and the server decides which one it wears —
 * `phaseOf` reads the import's own status, so closing the tab mid-import and
 * coming back later lands exactly where it left off rather than starting over.
 *
 * Nothing about models, tokens or escalation is shown. A teacher photographing
 * an exam is not choosing a model; what they need to know is which questions
 * to look at, and that is what the warnings and the "check this" badge say.
 */
export default function PaperImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [search] = useSearchParams();
  const courseId = search.get('course');
  const qc = useQueryClient();

  const { data: record, isLoading } = useQuery({
    queryKey: ['paper-import', id],
    queryFn: () => fetchImport(id!),
    enabled: !!id,
    // Polled only while the pages are actually being read. The interval is the
    // page count's problem, not the browser's: a job that takes four minutes
    // is still four minutes, and pretending otherwise is what a fake progress
    // bar does.
    refetchInterval: (query) => (phaseOf(query.state.data ?? null) === 'processing' ? 3000 : false),
  });

  const phase = phaseOf(record ?? null);

  if (!id) return <UploadStep courseId={courseId} />;
  if (isLoading || !record)
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );

  if (phase === 'processing') return <ProcessingStep record={record} />;
  if (phase === 'failed')
    return (
      <FailedStep
        record={record}
        onRetry={async () => {
          await retryImport(record.id);
          qc.invalidateQueries({ queryKey: ['paper-import', record.id] });
        }}
      />
    );
  if (phase === 'done')
    return (
      <div className="page">
        <PageHeader title={t('paper.doneTitle')} subtitle={t('paper.doneHint')} />
        <div className="card flex flex-wrap gap-3">
          <button
            className="btn-primary"
            onClick={() =>
              navigate(`/teacher/lessons/${record.lessonId}/quiz?course=${record.courseId}`)
            }
          >
            {t('paper.openExam')}
          </button>
          <Link className="btn-secondary" to={`/teacher/courses/${record.courseId}`}>
            {t('paper.openCourse')}
          </Link>
          <Link className="btn-ghost" to={`/teacher/lessons/${record.lessonId}/exam/print`}>
            {t('paper.exportPdf')}
          </Link>
        </div>
      </div>
    );

  return <ReviewStep record={record} courseId={courseId} />;
}

// ── upload ─────────────────────────────────────────────────────────────────

function UploadStep({ courseId }: { courseId: string | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: () => uploadPaper(files),
    onSuccess: ({ id }) =>
      navigate(`/teacher/paper-imports/${id}${courseId ? `?course=${courseId}` : ''}`),
  });

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('paper.eyebrow')}
        title={t('paper.uploadTitle')}
        subtitle={t('paper.uploadHint')}
      />
      <div className="card">
        <input
          ref={input}
          type="file"
          className="hidden"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <button
          type="button"
          className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-outline-variant py-12 text-center transition-colors hover:border-primary"
          onClick={() => input.current?.click()}
        >
          <span className="material-symbols-outlined text-5xl text-outline-variant">
            add_a_photo
          </span>
          <span className="font-heading font-semibold text-on-surface">{t('paper.pickFiles')}</span>
          <span className="text-sm text-outline">{t('paper.pickFilesHint')}</span>
        </button>

        {files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {files.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-low px-4 py-2 text-sm"
              >
                <span className="truncate text-on-surface">{file.name}</span>
                <span className="shrink-0 text-outline">{Math.round(file.size / 1024)} KB</span>
              </li>
            ))}
          </ul>
        )}

        <ErrorNote error={upload.error} />
        <button
          className="btn-primary mt-6"
          disabled={!files.length || upload.isPending}
          onClick={() => upload.mutate()}
        >
          {upload.isPending ? t('paper.uploading') : t('paper.startImport')}
        </button>
      </div>
    </div>
  );
}

// ── processing ─────────────────────────────────────────────────────────────

function ProcessingStep({
  record,
}: {
  record: NonNullable<Awaited<ReturnType<typeof fetchImport>>>;
}) {
  const { t } = useTranslation();
  const pct = progressPct(record);
  return (
    <div className="page">
      <PageHeader title={t('paper.processingTitle')} subtitle={t('paper.processingHint')} />
      <div className="card">
        <p className="mb-3 font-heading font-semibold text-on-surface">
          {t('paper.pagesRead', { done: record.progress.done, total: record.progress.total })}
        </p>
        <ProgressBar pct={pct} />
        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {record.pages.map((page) => (
            <li
              key={page.id}
              className="flex items-center gap-2 rounded-xl bg-surface-container-low px-4 py-2 text-sm"
            >
              <span className="material-symbols-outlined text-base text-outline">
                {page.status === 'PENDING'
                  ? 'hourglass_empty'
                  : page.status === 'FAILED'
                    ? 'error'
                    : 'check'}
              </span>
              <span className="text-on-surface">{t('paper.page', { n: page.pageNumber })}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FailedStep({
  record,
  onRetry,
}: {
  record: NonNullable<Awaited<ReturnType<typeof fetchImport>>>;
  onRetry: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const retry = useMutation({ mutationFn: onRetry });
  return (
    <div className="page">
      <PageHeader title={t('paper.failedTitle')} subtitle={record.error ?? t('paper.failedHint')} />
      <div className="card flex flex-wrap gap-3">
        <button className="btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {t('paper.retry')}
        </button>
        <Link className="btn-secondary" to="/teacher/paper-imports">
          {t('paper.startOver')}
        </Link>
        <ErrorNote error={retry.error} />
      </div>
    </div>
  );
}

// ── review ─────────────────────────────────────────────────────────────────

function ReviewStep({
  record,
  courseId,
}: {
  record: NonNullable<Awaited<ReturnType<typeof fetchImport>>>;
  courseId: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ExamDraft>(record.draft);
  const [target, setTarget] = useState<'NEW_COURSE' | 'EXISTING_COURSE'>(
    courseId ? 'EXISTING_COURSE' : 'NEW_COURSE',
  );
  const [pickedCourse, setPickedCourse] = useState(courseId ?? '');

  // The server's copy wins until the teacher touches it — a retry that filled
  // in a page must not be overwritten by a stale draft sitting in this tab.
  useEffect(() => setDraft(record.draft), [record.draft]);

  const { data: courses } = useQuery({
    queryKey: ['teacher-courses-brief'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
    staleTime: 60_000,
  });

  const questions = useMemo(() => allQuestions(draft), [draft]);
  const problems = draftProblems(draft);
  const unsupported = unsupportedCount(draft);

  const save = useMutation({ mutationFn: () => saveDraft(record.id, draft) });
  // Replaces the draft, edits included — which is what a teacher asking for it
  // wants, because the draft they are discarding is the one they could not use.
  const reread = useMutation({
    mutationFn: () => retryImport(record.id, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper-import', record.id] }),
  });
  const confirm = useMutation({
    mutationFn: async () => {
      await saveDraft(record.id, draft);
      return confirmImport(record.id, {
        target,
        courseId: target === 'EXISTING_COURSE' ? pickedCourse : undefined,
        title: draft.title,
        dropUnsupported: unsupported > 0,
      });
    },
    onSuccess: (built) => {
      qc.invalidateQueries({ queryKey: ['paper-import', record.id] });
      navigate(`/teacher/lessons/${built.lessonId}/quiz?course=${built.courseId}`);
    },
  });

  const update = (next: ExamDraft) => setDraft(next);

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('paper.eyebrow')}
        title={t('paper.reviewTitle')}
        subtitle={t('paper.reviewHint')}
        action={
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('paper.saveDraft')}
            </button>
            <button
              className="btn-primary"
              disabled={confirm.isPending || problems.includes('EMPTY')}
              onClick={() => confirm.mutate()}
            >
              {t('paper.confirm')}
            </button>
          </div>
        }
      />

      {/* A paper that came back mostly unreadable is not something to edit
          question by question. The offer to read it again properly comes
          first, before the teacher starts retyping an exam by hand. */}
      {looksUnreadable(draft) && (
        <div className="card mb-6 border-primary/20 bg-primary-fixed">
          <p className="mb-1 font-heading font-semibold text-on-surface">
            {t('paper.unreadableTitle')}
          </p>
          <p className="mb-4 text-sm text-on-surface-variant">{t('paper.unreadableHint')}</p>
          <button
            className="btn-primary"
            disabled={reread.isPending}
            onClick={() => reread.mutate()}
          >
            {reread.isPending ? t('paper.rereading') : t('paper.rereadStrong')}
          </button>
          <ErrorNote error={reread.error} />
        </div>
      )}

      {record.warnings.length > 0 && (
        <div className="card mb-6 border-error/20 bg-error-container">
          <p className="mb-2 font-heading font-semibold text-on-error-container">
            {t('paper.warningsTitle')}
          </p>
          <ul className="list-disc space-y-1 ps-5 text-sm text-on-error-container">
            {record.warnings.map((w, i) => {
              const key = warningKey(w.code);
              return (
                <li key={i}>
                  {w.page ? `${t('paper.page', { n: w.page })}: ` : ''}
                  {/* Composed here, in the reader's language. `detail` is the
                      server's fallback, for a code this build predates. */}
                  {key ? t(key, { ...(w.params ?? {}), defaultValue: w.detail }) : w.detail}
                </li>
              );
            })}
          </ul>
          {record.pages.some((p) => p.status === 'FAILED') && (
            <button
              className="btn-secondary mt-4"
              onClick={async () => {
                await retryImport(record.id);
                qc.invalidateQueries({ queryKey: ['paper-import', record.id] });
              }}
            >
              {t('paper.retryFailedPages')}
            </button>
          )}
        </div>
      )}

      <div className="card mb-6">
        <Field label={t('paper.examTitle')}>
          <input
            className="input"
            value={draft.title}
            onChange={(e) => update({ ...draft, title: e.target.value })}
          />
        </Field>
        <p className="text-sm text-outline">{t('paper.questionCount', { n: questions.length })}</p>
      </div>

      <div className="space-y-4">
        {questions.map((q) => (
          <QuestionCard
            key={q.id}
            importId={record.id}
            question={q}
            pages={record.pages}
            onChange={(patch) => update(editQuestion(draft, q.id, patch))}
            onType={(type) => update(changeType(draft, q.id, type))}
            onCorrect={(optionId, multi) => update(setCorrect(draft, q.id, optionId, multi))}
            onMove={(delta) => update(moveQuestion(draft, q.id, delta))}
            onRemove={() => update(removeQuestion(draft, q.id))}
          />
        ))}
      </div>

      <button className="btn-secondary mt-4" onClick={() => update(addQuestion(draft))}>
        {t('paper.addQuestion')}
      </button>

      <div className="card mt-8">
        <p className="mb-3 font-heading font-semibold text-on-surface">{t('paper.whereTitle')}</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="radio"
              checked={target === 'NEW_COURSE'}
              onChange={() => setTarget('NEW_COURSE')}
            />
            {t('paper.newCourse')}
          </label>
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="radio"
              checked={target === 'EXISTING_COURSE'}
              onChange={() => setTarget('EXISTING_COURSE')}
            />
            {t('paper.existingCourse')}
          </label>
          {target === 'EXISTING_COURSE' && (
            <select
              className="input"
              value={pickedCourse}
              onChange={(e) => setPickedCourse(e.target.value)}
            >
              <option value="">{t('paper.pickCourse')}</option>
              {(courses ?? []).map((c: { id: string; title: string }) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          )}
        </div>
        {unsupported > 0 && (
          <p className="mt-3 text-sm text-on-surface-variant">
            {t('paper.dropUnsupported', { n: unsupported })}
          </p>
        )}
        <ErrorNote error={confirm.error || save.error} />
      </div>
    </div>
  );
}

const TYPES: DraftType[] = ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'];

function QuestionCard({
  importId,
  question,
  pages,
  onChange,
  onType,
  onCorrect,
  onMove,
  onRemove,
}: {
  importId: string;
  question: DraftQuestion;
  pages: { id: string; pageNumber: number }[];
  onChange: (patch: Partial<DraftQuestion>) => void;
  onType: (type: DraftType) => void;
  onCorrect: (optionId: string, multi: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const sourcePage = pages.find((p) => p.pageNumber === question.sourcePages[0]);

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-heading font-semibold text-on-surface">{question.number}.</span>
        {question.needsReview && <Badge tone="warn">{t('paper.checkThis')}</Badge>}
        {question.type === 'UNSUPPORTED' && (
          <Badge tone="error">{question.unsupportedKind || t('paper.unsupported')}</Badge>
        )}
        <div className="ms-auto flex gap-1">
          <select
            className="input w-auto py-1 text-sm"
            value={question.type === 'UNSUPPORTED' ? '' : question.type}
            onChange={(e) => onType(e.target.value as DraftType)}
          >
            {question.type === 'UNSUPPORTED' && <option value="">{t('paper.chooseType')}</option>}
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`paper.type.${type}`)}
              </option>
            ))}
          </select>
          <button className="btn-ghost px-2" onClick={() => onMove(-1)} aria-label={t('paper.up')}>
            <span className="material-symbols-outlined text-base">arrow_upward</span>
          </button>
          <button className="btn-ghost px-2" onClick={() => onMove(1)} aria-label={t('paper.down')}>
            <span className="material-symbols-outlined text-base">arrow_downward</span>
          </button>
          <button
            className="btn-ghost px-2 text-error"
            onClick={onRemove}
            aria-label={t('paper.remove')}
          >
            <span className="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      </div>

      <textarea
        className="input min-h-20"
        value={question.text}
        onChange={(e) => onChange({ text: e.target.value })}
        placeholder={t('paper.questionText')}
      />

      {question.type !== 'SHORT_ANSWER' && question.type !== 'UNSUPPORTED' && (
        <ul className="mt-3 space-y-2">
          {question.options.map((option) => (
            <li key={option.id} className="flex items-center gap-2">
              <button
                type="button"
                className={`material-symbols-outlined text-xl ${option.correct ? 'text-primary' : 'text-outline'}`}
                onClick={() => onCorrect(option.id, false)}
                aria-label={t('paper.markCorrect')}
              >
                {option.correct ? 'radio_button_checked' : 'radio_button_unchecked'}
              </button>
              <input
                className="input"
                value={option.text}
                onChange={(e) =>
                  onChange({
                    options: question.options.map((o) =>
                      o.id === option.id ? { ...o, text: e.target.value } : o,
                    ),
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}

      {question.type === 'SHORT_ANSWER' && (
        <Field label={t('paper.modelAnswer')} hint={t('paper.modelAnswerHint')}>
          <textarea
            className="input"
            value={question.modelAnswer}
            onChange={(e) => onChange({ modelAnswer: e.target.value })}
          />
        </Field>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-outline">
        <label className="flex items-center gap-2">
          {t('paper.marks')}
          <input
            className="input w-20 py-1"
            type="number"
            min={1}
            value={question.marks ?? ''}
            onChange={(e) => onChange({ marks: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        {sourcePage && (
          <button className="btn-ghost px-2 py-1" onClick={() => setShowSource((v) => !v)}>
            {t('paper.seeSource', { n: sourcePage.pageNumber })}
          </button>
        )}
      </div>

      {showSource && sourcePage && (
        <SourcePage importId={importId} pageId={sourcePage.id} pageNumber={sourcePage.pageNumber} />
      )}
    </div>
  );
}

/**
 * The scan behind a question.
 *
 * Fetched through the API client rather than set as an `<img src>`, because
 * the route is authorized like every other teacher route and an `<img>` cannot
 * send a bearer token. The alternative — a signed public link, as payment
 * proofs use — would put somebody's unpublished exam paper behind a URL that
 * works without a session, which is not a trade worth making for one preview.
 */
function SourcePage({
  importId,
  pageId,
  pageNumber,
}: {
  importId: string;
  pageId: string;
  pageNumber: number;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl = '';
    api
      .get(`/teacher/paper-imports/${importId}/pages/${pageId}/source`, { responseType: 'blob' })
      .then(({ data }) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(data as Blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [importId, pageId]);

  if (!url)
    return (
      <div className="mt-3 grid place-items-center rounded-xl bg-surface-container-low py-10">
        <Spinner />
      </div>
    );
  return (
    <img
      className="mt-3 w-full rounded-xl border border-outline-variant"
      src={url}
      alt={t('paper.page', { n: pageNumber })}
    />
  );
}

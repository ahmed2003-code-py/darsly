import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ErrorNote, PageHeader, ProgressBar, Spinner } from '../../components/ui';
import { ExamReviewPanel } from './exam-studio/ExamReviewPanel';
import { ExamSpecForm } from './exam-studio/ExamSpecForm';
import { StudioProgress } from './exam-studio/StudioProgress';
import {
  CreationKind,
  ExamDraft,
  ExamSpec,
  PaperImport,
  cancelImport,
  confirmImport,
  creationState,
  draftProblems,
  fetchImport,
  phaseOf,
  retryImport,
  saveDraft,
  setSpec,
  unsupportedCount,
  uploadPaper,
  warningKey,
} from '../../lib/paperImport';

/**
 * The Exam Creation Studio.
 *
 * One screen with several faces, and the server decides which one it wears:
 * every state below is derived from what the worker actually recorded, so
 * closing the tab and coming back — or opening the same session on a phone —
 * lands exactly where the work is rather than at the beginning.
 *
 * Two ways in, one way out. A teacher who photographs an exam and a teacher
 * who uploads a lecture take different first steps and then meet at the same
 * review screen, producing the same ordinary Darsly exam.
 */
export default function ExamStudioPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const courseId = search.get('course');
  const qc = useQueryClient();

  const { data: record, isLoading } = useQuery({
    queryKey: ['exam-studio', id],
    queryFn: () => fetchImport(id!),
    enabled: !!id,
    // Polled only while the worker is actually working. The interval is the
    // job's problem, not the browser's: a four-minute job is four minutes, and
    // a bar that pretends otherwise is the thing this replaces.
    refetchInterval: (query) => {
      const phase = phaseOf(query.state.data ?? null);
      return phase === 'processing' ? 2500 : false;
    },
  });

  if (!id) return <ModeChoice courseId={courseId} />;
  if (isLoading || !record)
    return (
      <div className="grid place-items-center py-20">
        <Spinner />
      </div>
    );

  const refresh = () => qc.invalidateQueries({ queryKey: ['exam-studio', record.id] });
  const phase = phaseOf(record);

  if (phase === 'processing') return <Working record={record} onChange={refresh} />;
  if (phase === 'configuring') return <Configure record={record} onChange={refresh} />;
  if (phase === 'failed') return <Failed record={record} onChange={refresh} />;
  if (phase === 'done') return <Finished record={record} />;
  return <Review record={record} courseId={courseId} onChange={refresh} />;
}

// ── first screen: which way in ────────────────────────────────────────────

function ModeChoice({ courseId }: { courseId: string | null }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<CreationKind | null>(null);

  if (mode) return <Upload kind={mode} courseId={courseId} onBack={() => setMode(null)} />;

  return (
    <div className="page">
      <PageHeader title={t('examStudio.title')} subtitle={t('examStudio.subtitle')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice
          icon="description"
          title={t('examStudio.modePaper')}
          body={t('examStudio.modePaperHint')}
          onClick={() => setMode('PAPER')}
        />
        <Choice
          icon="auto_awesome"
          title={t('examStudio.modeContent')}
          body={t('examStudio.modeContentHint')}
          onClick={() => setMode('CONTENT')}
        />
      </div>
    </div>
  );
}

function Choice({
  icon,
  title,
  body,
  onClick,
}: {
  icon: string;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card card-hover flex flex-col items-start gap-2 text-start"
    >
      <span className="material-symbols-outlined text-3xl text-primary">{icon}</span>
      <span className="font-heading text-lg font-semibold text-on-surface">{title}</span>
      <span className="text-sm text-on-surface-variant">{body}</span>
    </button>
  );
}

// ── upload ────────────────────────────────────────────────────────────────

/**
 * The files, before anything is done to them.
 *
 * Shown as a list the teacher can edit — remove one, add another, move one up
 * — because the order is the order of the exam, and a photograph taken out of
 * sequence is the commonest thing to get wrong with a phone.
 */
function Upload({
  kind,
  courseId,
  onBack,
}: {
  kind: CreationKind;
  courseId: string | null;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [pct, setPct] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: () => uploadPaper(files, kind, setPct),
    onSuccess: ({ id }) =>
      navigate(`/teacher/exam-studio/${id}${courseId ? `?course=${courseId}` : ''}`),
  });

  const add = (picked: FileList | null) => {
    if (!picked) return;
    setFiles((current) => [...current, ...Array.from(picked)]);
    if (input.current) input.current.value = '';
  };
  const move = (index: number, delta: -1 | 1) =>
    setFiles((current) => {
      const to = index + delta;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('examStudio.title')}
        title={t(kind === 'PAPER' ? 'studio.modePaper' : 'studio.modeContent')}
        subtitle={t(kind === 'PAPER' ? 'studio.uploadPaperHint' : 'studio.uploadContentHint')}
        action={
          <button className="btn-ghost" onClick={onBack}>
            {t('examStudio.back')}
          </button>
        }
      />
      <div className="card">
        <input
          ref={input}
          type="file"
          className="hidden"
          multiple
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(e) => add(e.target.files)}
        />
        <button
          type="button"
          className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-outline-variant py-12 text-center transition-colors hover:border-primary"
          onClick={() => input.current?.click()}
        >
          <span className="material-symbols-outlined text-5xl text-outline-variant">
            {kind === 'PAPER' ? 'add_a_photo' : 'upload_file'}
          </span>
          <span className="font-heading font-semibold text-on-surface">
            {t('examStudio.pickFiles')}
          </span>
          <span className="text-sm text-outline">{t('examStudio.pickFilesHint')}</span>
        </button>

        {files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {files.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 py-2 text-sm"
              >
                <span className="w-6 shrink-0 text-outline" dir="ltr">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-on-surface">{file.name}</span>
                <span className="shrink-0 text-outline" dir="ltr">
                  {Math.round(file.size / 1024)} KB
                </span>
                <button
                  className="btn-ghost px-1 py-0"
                  onClick={() => move(i, -1)}
                  aria-label={t('paper.up')}
                >
                  <span className="material-symbols-outlined text-base">arrow_upward</span>
                </button>
                <button
                  className="btn-ghost px-1 py-0"
                  onClick={() => move(i, 1)}
                  aria-label={t('paper.down')}
                >
                  <span className="material-symbols-outlined text-base">arrow_downward</span>
                </button>
                <button
                  className="btn-ghost px-1 py-0 text-error"
                  onClick={() => setFiles((c) => c.filter((_, n) => n !== i))}
                  aria-label={t('paper.remove')}
                >
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {upload.isPending && (
          <div className="mt-4">
            <p className="mb-2 text-sm text-on-surface-variant">
              {t('examStudio.uploading', { pct })}
            </p>
            <ProgressBar pct={pct} />
          </div>
        )}

        <ErrorNote error={upload.error} />
        <button
          className="btn-primary mt-6"
          disabled={!files.length || upload.isPending}
          onClick={() => upload.mutate()}
        >
          {t(kind === 'PAPER' ? 'studio.startPaper' : 'studio.startContent')}
        </button>
      </div>
    </div>
  );
}

// ── working ───────────────────────────────────────────────────────────────

function Working({ record, onChange }: { record: PaperImport; onChange: () => void }) {
  const { t } = useTranslation();
  const cancel = useMutation({ mutationFn: () => cancelImport(record.id), onSuccess: onChange });
  return (
    <div className="page">
      <PageHeader
        eyebrow={t('examStudio.title')}
        title={t('examStudio.workingTitle')}
        subtitle={t('examStudio.workingHint')}
      />
      <StudioProgress
        record={record}
        canceling={cancel.isPending}
        onCancel={() => cancel.mutate()}
      />
      <ErrorNote error={cancel.error} />
    </div>
  );
}

function Configure({ record, onChange }: { record: PaperImport; onChange: () => void }) {
  const { t } = useTranslation();
  const start = useMutation({
    mutationFn: (spec: ExamSpec) => setSpec(record.id, spec),
    onSuccess: onChange,
  });
  return (
    <div className="page">
      <PageHeader
        eyebrow={t('examStudio.title')}
        title={t('examStudio.configureTitle')}
        subtitle={t('examStudio.configureHint', { n: record.pages.length })}
      />
      <ExamSpecForm
        initial={record.spec}
        chunkHint={record.pages.length}
        submitting={start.isPending}
        error={start.error}
        onSubmit={(spec) => start.mutate(spec)}
      />
    </div>
  );
}

function Failed({ record, onChange }: { record: PaperImport; onChange: () => void }) {
  const { t } = useTranslation();
  const retry = useMutation({ mutationFn: () => retryImport(record.id), onSuccess: onChange });
  const state = creationState(record);
  return (
    <div className="page">
      <PageHeader title={t(`examStudio.state.${state}`)} subtitle={t('examStudio.failedHint')} />
      <div className="card flex flex-wrap gap-3">
        <button className="btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {t('paper.retry')}
        </button>

        <Link className="btn-ghost" to="/teacher/exam-studio">
          {t('paper.startOver')}
        </Link>
      </div>
      <ErrorNote error={retry.error} />
    </div>
  );
}

function Finished({ record }: { record: PaperImport }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
}

// ── review ────────────────────────────────────────────────────────────────

function Review({
  record,
  courseId,
  onChange,
}: {
  record: PaperImport;
  courseId: string | null;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ExamDraft>(record.draft);
  const [target, setTarget] = useState<'NEW_COURSE' | 'EXISTING_COURSE'>(
    courseId ? 'EXISTING_COURSE' : 'NEW_COURSE',
  );
  const [pickedCourse, setPickedCourse] = useState(courseId ?? '');
  // Asking for a different exam from the same material. In place rather than
  // on its own route: the uploads and the chunks are already here, and a
  // teacher changing their mind about the question count should not feel like
  // they are starting again.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The server's copy wins until the teacher touches it — a retry that filled
  // in a page must not be overwritten by a stale draft sitting in this tab.
  useEffect(() => setDraft(record.draft), [record.draft]);

  const { data: courses } = useQuery({
    queryKey: ['teacher-courses-brief'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
    staleTime: 60_000,
  });

  const state = creationState(record);
  const problems = draftProblems(draft);
  const unsupported = unsupportedCount(draft);

  const save = useMutation({ mutationFn: () => saveDraft(record.id, draft) });
  const regenerateAll = useMutation({
    mutationFn: (spec: ExamSpec) => setSpec(record.id, spec),
    onSuccess: onChange,
  });
  const reread = useMutation({
    mutationFn: () => retryImport(record.id, true),
    onSuccess: onChange,
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
      onChange();
      navigate(`/teacher/lessons/${built.lessonId}/quiz?course=${built.courseId}`);
    },
  });

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('examStudio.title')}
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
      {state === 'HIGH_ACCURACY_AVAILABLE' && (
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
          <div className="mt-4 flex flex-wrap gap-2">
            {record.pages.some((p) => p.status === 'FAILED') && (
              <button
                className="btn-secondary"
                onClick={async () => {
                  await retryImport(record.id);
                  onChange();
                }}
              >
                {t('paper.retryFailedPages')}
              </button>
            )}
            {record.kind === 'CONTENT' && (
              <button className="btn-secondary" onClick={() => setSettingsOpen((v) => !v)}>
                {t('examStudio.changeSettings')}
              </button>
            )}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="mb-6">
          <ExamSpecForm
            initial={record.spec}
            chunkHint={record.pages.length}
            submitting={regenerateAll.isPending}
            error={regenerateAll.error}
            onSubmit={(spec) => regenerateAll.mutate(spec)}
          />
        </div>
      )}

      <ExamReviewPanel record={record} draft={draft} onDraft={setDraft} />

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

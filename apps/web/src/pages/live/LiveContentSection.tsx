import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNote, Field, Modal, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import ExamSourceDialog from './ExamSourceDialog';

/**
 * «حوّل حصتك إلى محتوى» — a finished class, reused as course content.
 *
 * Everything happens on the server's existing systems: the recording becomes
 * a lesson (the same video — nothing is uploaded again), the transcript and
 * study notes are copied into it if the teacher wants, an exam is written in
 * the Exam Studio from the class's transcript and published only after
 * review. This section only asks, and then says plainly what happened.
 */

interface ContentStatus {
  eligible: boolean;
  ended: boolean;
  recordingReady: boolean;
  transcript: { status: string; usable: boolean; partial: boolean; durationSec?: number | null };
  summaryReady: boolean;
  lessons: {
    id: string;
    title: string;
    type: 'VIDEO' | 'QUIZ' | 'ASSIGNMENT';
    isRecording: boolean;
    course: { id: string; title: string; status: string };
    unit: { id: string; title: string; isDefault: boolean };
    questionCount: number | null;
  }[];
  examSession: {
    id: string;
    status: string;
    stage: string;
    lessonId: string | null;
    partial: boolean;
  } | null;
}

type Dialog = null | 'existing' | 'new' | 'link' | 'exam';

const errCode = (e: unknown) =>
  (e as { response?: { data?: { code?: string } } })?.response?.data?.code;

export default function LiveContentSection({
  sessionId,
  sessionTitle,
  sessionDescription,
}: {
  sessionId: string;
  sessionTitle: string;
  sessionDescription?: string | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const key = ['live-content', sessionId];
  const status = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await api.get(`/teacher/live/${sessionId}/content`)).data as ContentStatus,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const courseParam = () => {
    const c = status.data?.lessons.find((l) => l.isRecording)?.course.id;
    return c ? `?course=${c}` : '';
  };

  if (status.isLoading) return <Skeleton className="h-24 w-full" />;
  if (status.isError || !status.data) return <ErrorNote error={status.error} />;
  const s = status.data;
  if (!s.eligible) return null;

  const recordingLesson = s.lessons.find((l) => l.isRecording);
  const exams = s.lessons.filter((l) => l.type === 'QUIZ');
  const openExamSession =
    s.examSession && s.examSession.status !== 'COMPLETED' ? s.examSession : null;

  // One session per class: an open one is reopened, otherwise the sources are chosen first.
  const startExam = () =>
    openExamSession
      ? navigate(`/teacher/exam-studio/${openExamSession.id}${courseParam()}`)
      : setDialog('exam');

  return (
    <section
      id="rec-content"
      className="my-4 scroll-mt-4 rounded-2xl border border-primary/25 bg-gradient-to-br from-primary-fixed/40 via-surface to-surface p-4 sm:p-5"
      aria-labelledby="rec-content-title"
    >
      <div className="mb-3 flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary text-on-primary"
        >
          <span className="material-symbols-outlined">auto_stories</span>
        </span>
        <div className="min-w-0">
          <h3 id="rec-content-title" className="font-heading text-lg font-bold">
            {t('liveContent.title')}
          </h3>
          <p className="text-sm text-on-surface-variant">{t('liveContent.subtitle')}</p>
        </div>
      </div>

      {/* What it already became. */}
      {recordingLesson && (
        <div
          className="mb-3 rounded-xl border border-emerald-600/30 bg-emerald-600/5 p-3"
          role="status"
        >
          <p className="flex items-start gap-2 text-sm font-semibold">
            <span aria-hidden className="material-symbols-outlined text-[18px] text-emerald-600">
              check_circle
            </span>
            <span className="min-w-0">
              {t('liveContent.addedTo')} <span dir="auto">{recordingLesson.course.title}</span>
              {!recordingLesson.unit.isDefault && (
                <>
                  {' ← '}
                  <span dir="auto">{recordingLesson.unit.title}</span>
                </>
              )}
              {' ← '}
              <span dir="auto">{recordingLesson.title}</span>
            </span>
          </p>
          {recordingLesson.course.status === 'DRAFT' && (
            <p className="ms-6 mt-1 text-xs text-on-surface-variant">
              {t('liveContent.courseIsDraft')}
            </p>
          )}
          <div className="ms-6 mt-2 flex flex-wrap gap-2">
            <Link
              className="btn-secondary !py-1.5 text-sm"
              to={`/learn/${recordingLesson.course.id}/${recordingLesson.id}`}
            >
              {t('liveContent.openLesson')}
            </Link>
            <Link
              className="btn-ghost !py-1.5 text-sm"
              to={`/teacher/courses/${recordingLesson.course.id}`}
            >
              {t('liveContent.editLesson')}
            </Link>
          </div>
        </div>
      )}
      {exams.map((e) => (
        <div
          key={e.id}
          className="mb-3 rounded-xl border border-emerald-600/30 bg-emerald-600/5 p-3"
          role="status"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden className="material-symbols-outlined text-[18px] text-emerald-600">
              check_circle
            </span>
            {t('liveContent.examLinked', { count: e.questionCount ?? 0 })}
            <span className="truncate font-normal text-on-surface-variant" dir="auto">
              — {e.title}
            </span>
          </p>
          <div className="ms-6 mt-2 flex flex-wrap gap-2">
            <Link className="btn-secondary !py-1.5 text-sm" to={`/learn/${e.course.id}/${e.id}`}>
              {t('liveContent.openExam')}
            </Link>
            <Link
              className="btn-ghost !py-1.5 text-sm"
              to={`/teacher/lessons/${e.id}/quiz?course=${e.course.id}`}
            >
              {t('liveContent.editExam')}
            </Link>
          </div>
        </div>
      ))}
      {openExamSession && (
        <div className="mb-3 rounded-xl border border-outline-variant/60 p-3 text-sm">
          <p className="font-semibold">{t('liveContent.examInProgress')}</p>
          {openExamSession.partial && (
            <p className="text-xs text-on-surface-variant">{t('liveContent.examPartialBody')}</p>
          )}
          <Link
            className="btn-secondary mt-2 !py-1.5 text-sm"
            to={`/teacher/exam-studio/${openExamSession.id}${courseParam()}`}
          >
            {t('liveContent.openStudio')}
          </Link>
        </div>
      )}

      {/* What it can still become. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {!recordingLesson && (
          <>
            <button
              type="button"
              className="btn-primary justify-center"
              onClick={() => setDialog('existing')}
            >
              <span aria-hidden className="material-symbols-outlined text-[18px]">
                playlist_add
              </span>
              {t('liveContent.addToCourse')}
            </button>
            <button
              type="button"
              className="btn-secondary justify-center"
              onClick={() => setDialog('new')}
            >
              <span aria-hidden className="material-symbols-outlined text-[18px]">
                video_library
              </span>
              {t('liveContent.newLesson')}
            </button>
          </>
        )}
        <button type="button" className="btn-secondary justify-center" onClick={startExam}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            quiz
          </span>
          {openExamSession ? t('liveContent.openStudio') : t('liveContent.createExam')}
        </button>
      </div>
      {!s.transcript.usable && !openExamSession && (
        <p className="mt-2 text-xs text-on-surface-variant">
          {t('liveContent.examWithoutTranscript')}
        </p>
      )}
      {recordingLesson && (
        <button
          type="button"
          className="mt-3 text-sm font-semibold text-primary-text hover:underline"
          onClick={() => setDialog('link')}
        >
          {t('liveContent.linkExam')}
        </button>
      )}

      {(dialog === 'existing' || dialog === 'new') && (
        <PublishDialog
          mode={dialog}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          sessionDescription={sessionDescription ?? ''}
          status={s}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog === 'exam' && (
        <ExamSourceDialog
          sessionId={sessionId}
          transcript={s.transcript}
          onClose={() => setDialog(null)}
          // Straight to the Exam Studio; the recording's course is offered as where the exam goes.
          onCreated={(id) => navigate(`/teacher/exam-studio/${id}${courseParam()}`)}
        />
      )}
      {dialog === 'link' && (
        <LinkExamDialog
          sessionId={sessionId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

type Grade = { id: string; stage?: string; nameAr: string; nameEn: string };

function PublishDialog({
  mode,
  sessionId,
  sessionTitle,
  sessionDescription,
  status,
  onClose,
  onDone,
}: {
  mode: 'existing' | 'new';
  sessionId: string;
  sessionTitle: string;
  sessionDescription: string;
  status: ContentStatus;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  const [courseId, setCourseId] = useState('');
  const [unit, setUnit] = useState<string>(''); // '' = no section, '__new' = new one, else unit id
  const [newUnitTitle, setNewUnitTitle] = useState('');
  const [title, setTitle] = useState(sessionTitle);
  const [description, setDescription] = useState(sessionDescription);
  const [courseTitle, setCourseTitle] = useState(sessionTitle);
  const [gradeId, setGradeId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [includeSummary, setIncludeSummary] = useState(status.summaryReady);
  const [includeTranscript, setIncludeTranscript] = useState(status.transcript.usable);
  const busy = useRef(false);

  const courses = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () =>
      (await api.get('/teacher/courses')).data as {
        id: string;
        title: string;
        status: string;
        kind?: string;
      }[],
    enabled: mode === 'existing',
  });
  const course = useQuery({
    queryKey: ['teacher-course', courseId],
    queryFn: async () =>
      (await api.get(`/teacher/courses/${courseId}`)).data as {
        units: { id: string; title: string; isDefault: boolean }[];
      },
    enabled: mode === 'existing' && !!courseId,
  });
  const profile = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
    enabled: mode === 'new',
  });
  const grades = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data as Grade[],
    enabled: mode === 'new',
  });
  const myStages: string[] = profile.data?.stages ?? [];
  const myYears = (grades.data ?? []).filter((g) => g.stage && myStages.includes(g.stage));
  const mySubjects: { id: string; nameAr: string; nameEn: string }[] = (
    profile.data?.subjects ?? []
  ).map((s: { subject: { id: string; nameAr: string; nameEn: string } }) => s.subject);
  useEffect(() => {
    if (!gradeId && myYears.length === 1) setGradeId(myYears[0].id);
  }, [gradeId, myYears]);

  const usable = (courses.data ?? []).filter((c) => c.status !== 'ARCHIVED' && c.kind !== 'EXAM');
  const sections = (course.data?.units ?? []).filter((u) => !u.isDefault);
  const ready =
    title.trim().length > 0 &&
    (mode === 'existing'
      ? !!courseId && (unit !== '__new' || newUnitTitle.trim().length > 0)
      : courseTitle.trim().length > 0 && !!gradeId && (mySubjects.length <= 1 || !!subjectId));

  const publish = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/teacher/live/${sessionId}/content/lesson`, {
          target: mode === 'existing' ? 'EXISTING_COURSE' : 'NEW_COURSE',
          ...(mode === 'existing'
            ? {
                courseId,
                ...(unit && unit !== '__new' ? { unitId: unit } : {}),
                ...(unit === '__new' ? { newUnitTitle: newUnitTitle.trim() } : {}),
              }
            : {
                newCourse: {
                  title: courseTitle.trim(),
                  description: description.trim() || undefined,
                  gradeId,
                  ...(mySubjects.length > 1 ? { subjectId } : {}),
                },
              }),
          title: title.trim(),
          description: description.trim() || undefined,
          includeSummary,
          includeTranscript,
        })
      ).data,
    onSuccess: onDone,
    onError: (e) => {
      // Someone (another tab) already did it: the section below says where.
      if (errCode(e) === 'VIDEO_IN_USE') onDone();
    },
    onSettled: () => {
      busy.current = false;
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'existing' ? t('liveContent.addToCourse') : t('liveContent.newCourseTitle')}
      wide
    >
      <div className="space-y-4">
        {mode === 'existing' ? (
          <>
            <Field label={t('liveContent.chooseCourse')} id="lc-course">
              {courses.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : usable.length ? (
                <select
                  id="lc-course"
                  className="input"
                  value={courseId}
                  onChange={(e) => {
                    setCourseId(e.target.value);
                    setUnit('');
                  }}
                >
                  <option value="">{t('liveContent.pickCourse')}</option>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                      {c.status === 'DRAFT' ? ` (${t('liveContent.draft')})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-on-surface-variant">{t('liveContent.noCourses')}</p>
              )}
            </Field>
            {courseId && (
              <Field label={t('liveContent.chooseSection')} id="lc-section">
                <select
                  id="lc-section"
                  className="input"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                >
                  <option value="">{t('liveContent.noSection')}</option>
                  {sections.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.title}
                    </option>
                  ))}
                  <option value="__new">{t('liveContent.newSection')}</option>
                </select>
                {unit === '__new' && (
                  <input
                    className="input mt-2"
                    dir="auto"
                    maxLength={200}
                    value={newUnitTitle}
                    placeholder={t('liveContent.newSectionPlaceholder')}
                    aria-label={t('liveContent.newSectionPlaceholder')}
                    onChange={(e) => setNewUnitTitle(e.target.value)}
                  />
                )}
              </Field>
            )}
          </>
        ) : (
          <>
            <p className="rounded-xl bg-surface-container-low p-3 text-sm text-on-surface-variant">
              {t('liveContent.newCourseHint')}
            </p>
            <Field label={t('liveContent.courseName')} id="lc-course-title">
              <input
                id="lc-course-title"
                className="input"
                dir="auto"
                maxLength={200}
                value={courseTitle}
                onChange={(e) => setCourseTitle(e.target.value)}
              />
            </Field>
            <Field label={t('liveContent.year')} id="lc-grade">
              <select
                id="lc-grade"
                className="input"
                value={gradeId}
                onChange={(e) => setGradeId(e.target.value)}
              >
                <option value="">{t('liveContent.pickYear')}</option>
                {myYears.map((g) => (
                  <option key={g.id} value={g.id}>
                    {ar ? g.nameAr : g.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            {mySubjects.length > 1 && (
              <Field label={t('liveContent.subject')} id="lc-subject">
                <select
                  id="lc-subject"
                  className="input"
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                >
                  <option value="">{t('liveContent.pickSubject')}</option>
                  {mySubjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {ar ? s.nameAr : s.nameEn}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}

        <Field label={t('liveContent.lessonTitle')} id="lc-title">
          <input
            id="lc-title"
            className="input"
            dir="auto"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label={t('liveContent.lessonDescription')} id="lc-desc">
          <textarea
            id="lc-desc"
            className="input"
            dir="auto"
            rows={3}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">{t('liveContent.includeTitle')}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked disabled className="mt-1 accent-primary" />
            <span>{t('liveContent.includeRecording')}</span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${status.summaryReady ? '' : 'opacity-60'}`}
          >
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={includeSummary}
              disabled={!status.summaryReady}
              onChange={(e) => setIncludeSummary(e.target.checked)}
            />
            <span>
              {t('liveContent.includeSummary')}
              {!status.summaryReady && (
                <span className="block text-xs text-on-surface-variant">
                  {t('liveContent.summaryUnavailable')}
                </span>
              )}
            </span>
          </label>
          <label
            className={`flex items-start gap-2 text-sm ${status.transcript.usable ? '' : 'opacity-60'}`}
          >
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={includeTranscript}
              disabled={!status.transcript.usable}
              onChange={(e) => setIncludeTranscript(e.target.checked)}
            />
            <span>
              {t('liveContent.includeTranscript')}
              {status.transcript.partial && (
                <span className="block text-xs text-on-surface-variant">
                  {t('record.transcript.partial')}
                </span>
              )}
              {!status.transcript.usable && (
                <span className="block text-xs text-on-surface-variant">
                  {t('liveContent.transcriptUnavailable')}
                </span>
              )}
            </span>
          </label>
          <p className="text-xs text-on-surface-variant">{t('liveContent.noExtraCost')}</p>
        </fieldset>

        <ErrorNote error={publish.error} />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!ready || publish.isPending}
            aria-busy={publish.isPending || undefined}
            onClick={() => {
              if (busy.current || publish.isPending) return;
              busy.current = true;
              publish.mutate();
            }}
          >
            {publish.isPending
              ? t('common.saving')
              : mode === 'existing'
                ? t('liveContent.submitExisting')
                : t('liveContent.submitNew')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LinkExamDialog({
  sessionId,
  onClose,
  onDone,
}: {
  sessionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState('');
  const busy = useRef(false);
  const list = useQuery({
    queryKey: ['live-content-exams', sessionId],
    queryFn: async () =>
      (await api.get(`/teacher/live/${sessionId}/content/exam-candidates`)).data as {
        courseId: string | null;
        exams: { id: string; title: string; unitTitle: string }[];
      },
  });
  const link = useMutation({
    mutationFn: async () =>
      (await api.post(`/teacher/live/${sessionId}/content/link-exam`, { examLessonId: pick })).data,
    onSuccess: onDone,
    onSettled: () => {
      busy.current = false;
    },
  });
  const exams = list.data?.exams ?? [];
  return (
    <Modal open onClose={onClose} title={t('liveContent.linkExam')}>
      <div className="space-y-3">
        <p className="text-sm text-on-surface-variant">{t('liveContent.linkHint')}</p>
        {list.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : exams.length ? (
          <div className="space-y-2" role="radiogroup">
            {exams.map((e) => (
              <label
                key={e.id}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm ${pick === e.id ? 'border-primary' : 'border-outline-variant/60'}`}
              >
                <input
                  type="radio"
                  name="lc-exam"
                  className="accent-primary"
                  checked={pick === e.id}
                  onChange={() => setPick(e.id)}
                />
                <span className="min-w-0">
                  <span className="block font-semibold" dir="auto">
                    {e.title}
                  </span>
                  <span className="block text-xs text-on-surface-variant" dir="auto">
                    {e.unitTitle}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-on-surface-variant">{t('liveContent.noExams')}</p>
        )}
        <ErrorNote error={link.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!pick || link.isPending}
            onClick={() => {
              if (busy.current || link.isPending) return;
              busy.current = true;
              link.mutate();
            }}
          >
            {link.isPending ? t('common.saving') : t('liveContent.linkSubmit')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

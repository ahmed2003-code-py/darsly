import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { duration, egp } from '../../lib/format';
import { Badge, ErrorNote, Field, ProgressBar, Spinner } from '../../components/ui';

/**
 * Course builder per the course_builder design: curriculum tree in the middle
 * (units → lessons), lesson-settings panel on the side (drip scheduling,
 * paid/free-preview toggle, video + attachment uploads with progress).
 */
export default function CourseBuilderPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const queryClient = useQueryClient();

  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [newUnitTitle, setNewUnitTitle] = useState('');
  const [addingUnit, setAddingUnit] = useState(false);
  const [newLessonUnit, setNewLessonUnit] = useState<string | null>(null);
  const [newLessonTitle, setNewLessonTitle] = useState('');
  const [videoPct, setVideoPct] = useState<number | null>(null);
  const [filePct, setFilePct] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Lesson-settings drafts (per selected lesson)
  const [drip, setDrip] = useState<'now' | 'date' | 'days'>('now');
  const [dripDate, setDripDate] = useState('');
  const [dripDays, setDripDays] = useState('');
  const [freePreview, setFreePreview] = useState(false);
  const [durationMin, setDurationMin] = useState('');

  const videoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: course, isLoading } = useQuery({
    queryKey: ['teacher-course', id],
    queryFn: async () => (await api.get(`/teacher/courses/${id}`)).data,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['teacher-course', id] });
    queryClient.invalidateQueries({ queryKey: ['teacher-courses'] });
  };

  const addUnit = useMutation({
    mutationFn: async (title: string) =>
      (await api.post(`/teacher/courses/${id}/units`, { title })).data,
    onSuccess: () => {
      invalidate();
      setNewUnitTitle('');
      setAddingUnit(false);
    },
  });
  const removeUnit = useMutation({
    mutationFn: async (unitId: string) => (await api.delete(`/teacher/units/${unitId}`)).data,
    onSuccess: invalidate,
  });
  const addLesson = useMutation({
    mutationFn: async ({ unitId, title }: { unitId: string; title: string }) =>
      (await api.post(`/teacher/units/${unitId}/lessons`, { title })).data,
    onSuccess: (lesson) => {
      invalidate();
      setNewLessonTitle('');
      setNewLessonUnit(null);
      selectLesson(lesson);
    },
  });
  const removeLesson = useMutation({
    mutationFn: async (lessonId: string) => (await api.delete(`/teacher/lessons/${lessonId}`)).data,
    onSuccess: () => {
      invalidate();
      setSelectedLessonId(null);
    },
  });
  const saveLesson = useMutation({
    mutationFn: async (payload: any) =>
      (await api.patch(`/teacher/lessons/${selectedLessonId}`, payload)).data,
    onSuccess: () => {
      invalidate();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    },
  });
  const publish = useMutation({
    mutationFn: async (status: string) =>
      (await api.patch(`/teacher/courses/${id}`, { status })).data,
    onSuccess: invalidate,
  });

  async function uploadVideo(file: File) {
    setVideoPct(0);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data: asset } = await api.post('/uploads/videos', fd, {
        onUploadProgress: (e) => setVideoPct(Math.round((e.loaded / (e.total ?? file.size)) * 100)),
      });
      await api.patch(`/teacher/lessons/${selectedLessonId}`, { videoAssetId: asset.id });
      invalidate();
    } finally {
      setVideoPct(null);
    }
  }

  async function uploadAttachment(file: File) {
    setFilePct(0);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/uploads/lessons/${selectedLessonId}/attachments`, fd, {
        onUploadProgress: (e) => setFilePct(Math.round((e.loaded / (e.total ?? file.size)) * 100)),
      });
      invalidate();
    } finally {
      setFilePct(null);
    }
  }

  const removeAttachment = useMutation({
    mutationFn: async (attachmentId: string) =>
      (await api.delete(`/uploads/attachments/${attachmentId}`)).data,
    onSuccess: invalidate,
  });

  function selectLesson(lesson: any) {
    setSelectedLessonId(lesson.id);
    setFreePreview(!!lesson.isFreePreview);
    setDurationMin(lesson.durationSec ? String(Math.round(lesson.durationSec / 60)) : '');
    if (lesson.dripUnlockAt) {
      setDrip('date');
      setDripDate(lesson.dripUnlockAt.slice(0, 10));
      setDripDays('');
    } else if (lesson.dripAfterEnrollDays != null) {
      setDrip('days');
      setDripDays(String(lesson.dripAfterEnrollDays));
      setDripDate('');
    } else {
      setDrip('now');
      setDripDate('');
      setDripDays('');
    }
  }

  function saveSettings() {
    saveLesson.mutate({
      isFreePreview: freePreview,
      durationSec: durationMin ? Number(durationMin) * 60 : 0,
      // Always reset the previous schedule, then apply the chosen mode.
      clearDrip: true,
      ...(drip === 'date' && dripDate
        ? { dripUnlockAt: new Date(dripDate).toISOString() }
        : drip === 'days'
          ? { dripAfterEnrollDays: Number(dripDays || 0) }
          : {}),
    });
  }

  if (isLoading || !course) return <Spinner />;

  const lessons = course.units.flatMap((u: any) => u.lessons);
  const selected = lessons.find((l: any) => l.id === selectedLessonId) ?? null;
  const totalSec = lessons.reduce((s: number, l: any) => s + (l.durationSec ?? 0), 0);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      {/* Header */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 flex items-center gap-1 text-sm text-outline">
            <Link to="/teacher/courses" className="text-primary hover:underline">
              {t('teacher.builder.back')}
            </Link>
            <span className="material-symbols-outlined text-sm rtl:rotate-180">chevron_left</span>
            <span>{course.title}</span>
          </p>
          <h1 className="font-heading text-4xl font-extrabold">{t('teacher.builder.title')}</h1>
          <p className="mt-2 text-on-surface-variant">{t('teacher.builder.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={course.status === 'PUBLISHED' ? 'teal' : 'warn'}>
            {course.status === 'PUBLISHED' ? t('teacher.builder.published') : t('teacher.builder.draft')}
          </Badge>
          {course.status !== 'PUBLISHED' && (
            <button className="btn-primary" disabled={publish.isPending} onClick={() => publish.mutate('PUBLISHED')}>
              {t('teacher.builder.publishChanges')}
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={publish.error} />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Curriculum tree */}
        <section className="min-w-0 flex-1">
          <button
            className="btn-secondary mb-5 flex items-center gap-2 py-2 text-sm"
            onClick={() => setAddingUnit(true)}
          >
            <span className="material-symbols-outlined">add</span>
            {t('teacher.builder.addUnit')}
          </button>

          {addingUnit && (
            <form
              className="card mb-4 flex gap-2 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (newUnitTitle.trim()) addUnit.mutate(newUnitTitle.trim());
              }}
            >
              <input autoFocus className="input py-2" placeholder={t('teacher.builder.unitTitlePlaceholder')}
                value={newUnitTitle} onChange={(e) => setNewUnitTitle(e.target.value)} />
              <button className="btn-primary px-4 py-2 text-sm" disabled={addUnit.isPending}>{t('common.save')}</button>
              <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => setAddingUnit(false)}>
                {t('common.cancel')}
              </button>
            </form>
          )}

          <div className="space-y-5">
            {course.units.map((u: any, ui: number) => (
              <div key={u.id} className="card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Badge>{t('teacher.builder.unitBadge', { n: ui + 1 })}</Badge>
                    <h3 className="font-heading text-lg font-bold">{u.title}</h3>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-outline">
                    <span>
                      {t('teacher.builder.lessonsMeta', { count: u.lessons.length })} ·{' '}
                      {duration(u.lessons.reduce((s: number, l: any) => s + (l.durationSec ?? 0), 0))}
                    </span>
                    <button
                      className="text-error/70 hover:text-error"
                      onClick={() => window.confirm(t('teacher.builder.deleteUnitConfirm')) && removeUnit.mutate(u.id)}
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </div>

                <ul className="space-y-2">
                  {u.lessons.map((l: any, li: number) => (
                    <li
                      key={l.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition ${
                        selectedLessonId === l.id
                          ? 'border-primary-container bg-primary-fixed/40'
                          : 'border-outline-variant/40 bg-surface-container-lowest hover:bg-surface-container-low'
                      }`}
                      onClick={() => selectLesson(l)}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
                        <span className="material-symbols-outlined text-xl">
                          {l.type === 'QUIZ' ? 'quiz' : l.type === 'ASSIGNMENT' ? 'assignment' : l.videoAsset ? 'play_circle' : 'draft'}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold">
                          {li + 1}. {l.title}
                        </p>
                        <p className="flex flex-wrap gap-2 text-xs text-outline">
                          {l.durationSec > 0 && <span>{duration(l.durationSec)}</span>}
                          {l.isFreePreview && <span className="text-secondary">{t('teacher.builder.freePreview')}</span>}
                          {(l.dripUnlockAt || l.dripAfterEnrollDays != null) && (
                            <span className="flex items-center gap-0.5">
                              <span className="material-symbols-outlined text-xs">lock_clock</span>
                              Drip
                            </span>
                          )}
                          {l.attachments?.length > 0 && (
                            <span>{t('course.attachmentsCount', { count: l.attachments.length })}</span>
                          )}
                        </p>
                      </div>
                      <button
                        className="text-error/70 hover:text-error"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(t('teacher.builder.deleteLessonConfirm'))) removeLesson.mutate(l.id);
                        }}
                      >
                        <span className="material-symbols-outlined text-base">delete</span>
                      </button>
                    </li>
                  ))}
                </ul>

                {newLessonUnit === u.id ? (
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newLessonTitle.trim()) addLesson.mutate({ unitId: u.id, title: newLessonTitle.trim() });
                    }}
                  >
                    <input autoFocus className="input py-2" placeholder={t('teacher.builder.lessonTitlePlaceholder')}
                      value={newLessonTitle} onChange={(e) => setNewLessonTitle(e.target.value)} />
                    <button className="btn-primary px-4 py-2 text-sm" disabled={addLesson.isPending}>{t('common.save')}</button>
                    <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => setNewLessonUnit(null)}>
                      {t('common.cancel')}
                    </button>
                  </form>
                ) : (
                  <button
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant py-3 text-sm text-on-surface-variant transition hover:border-primary hover:text-primary"
                    onClick={() => {
                      setNewLessonUnit(u.id);
                      setNewLessonTitle('');
                    }}
                  >
                    <span className="material-symbols-outlined">add_circle</span>
                    {t('teacher.builder.addLesson')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Side panel: pricing + lesson settings */}
        <aside className="w-full shrink-0 space-y-5 lg:w-96">
          <div className="card">
            <h3 className="mb-3 font-heading text-lg font-bold">{t('teacher.builder.pricing')}</h3>
            <p className="flex items-baseline justify-between">
              <span className="text-sm text-on-surface-variant">
                {t(`teacher.courses.form.${course.pricingModel === 'ONE_TIME' ? 'oneTime' : course.pricingModel === 'MONTHLY_SUBSCRIPTION' ? 'monthly' : 'bundle'}`)}
              </span>
              <span className="font-heading text-2xl font-extrabold">
                {egp(course.priceCents)}
                {course.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
                  <span className="text-xs font-normal text-outline">/{t('course.perMonth')}</span>
                )}
              </span>
            </p>
            <p className="mt-2 text-xs text-outline">
              {t('course.lessonsCount', { count: lessons.length })} · {duration(totalSec)}
            </p>
          </div>

          {selected ? (
            <div className="card">
              <h3 className="mb-1 font-heading text-lg font-bold">{t('teacher.builder.settings')}</h3>
              <p className="mb-4 rounded-lg bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant">
                {t('teacher.builder.editing')} <b>{selected.title}</b>
              </p>

              {/* Drip */}
              <p className="mb-2 flex items-center gap-1 text-sm font-bold">
                <span className="material-symbols-outlined text-base">lock_clock</span>
                {t('teacher.builder.drip')}
              </p>
              <div className="mb-4 space-y-2">
                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'now' ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/50'}`}>
                  <input type="radio" className="mt-1 accent-primary" checked={drip === 'now'} onChange={() => setDrip('now')} />
                  <span>
                    <span className="block text-sm font-bold">{t('teacher.builder.dripImmediate')}</span>
                    <span className="text-xs text-outline">{t('teacher.builder.dripImmediateHint')}</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'date' ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/50'}`}>
                  <input type="radio" className="mt-1 accent-primary" checked={drip === 'date'} onChange={() => setDrip('date')} />
                  <span className="flex-1">
                    <span className="block text-sm font-bold">{t('teacher.builder.dripDate')}</span>
                    {drip === 'date' && (
                      <input type="date" className="input mt-2 py-1.5 text-sm" value={dripDate}
                        onChange={(e) => setDripDate(e.target.value)} />
                    )}
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'days' ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/50'}`}>
                  <input type="radio" className="mt-1 accent-primary" checked={drip === 'days'} onChange={() => setDrip('days')} />
                  <span className="flex-1">
                    <span className="block text-sm font-bold">{t('teacher.builder.dripDays')}</span>
                    {drip === 'days' && (
                      <span className="mt-2 flex items-center gap-2">
                        <input className="input w-20 py-1.5 text-sm" inputMode="numeric" value={dripDays}
                          onChange={(e) => setDripDays(e.target.value.replace(/\D/g, ''))} />
                        <span className="text-xs text-outline">{t('teacher.builder.dripDaysHint')}</span>
                      </span>
                    )}
                  </span>
                </label>
              </div>

              {/* Access type */}
              <p className="mb-2 flex items-center gap-1 text-sm font-bold">
                <span className="material-symbols-outlined text-base">visibility</span>
                {t('teacher.builder.accessType')}
              </p>
              <div className="mb-1 grid grid-cols-2 overflow-hidden rounded-lg border border-outline-variant/60">
                <button type="button"
                  className={`py-2 text-sm font-bold ${!freePreview ? 'bg-primary-fixed text-primary' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                  onClick={() => setFreePreview(false)}>
                  {t('teacher.builder.paid')}
                </button>
                <button type="button"
                  className={`py-2 text-sm font-bold ${freePreview ? 'bg-primary-fixed text-primary' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                  onClick={() => setFreePreview(true)}>
                  {t('teacher.builder.freePreview')}
                </button>
              </div>
              <p className="mb-4 text-xs text-outline">{t('teacher.builder.freePreviewHint')}</p>

              {/* Assessment (quiz / assignment authoring) */}
              <p className="mb-2 flex items-center gap-1 text-sm font-bold">
                <span className="material-symbols-outlined text-base">quiz</span>
                {t('assess.builder.section')}
              </p>
              <div className="mb-4 grid grid-cols-2 gap-2">
                <Link to={`/teacher/lessons/${selected.id}/quiz`}
                  className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary">
                  <span className="material-symbols-outlined text-base">quiz</span>
                  {t('assess.builder.editQuiz')}
                </Link>
                <Link to={`/teacher/lessons/${selected.id}/assignment`}
                  className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary">
                  <span className="material-symbols-outlined text-base">assignment</span>
                  {t('assess.builder.editAssignment')}
                </Link>
              </div>

              {/* Video */}
              <p className="mb-2 flex items-center gap-1 text-sm font-bold">
                <span className="material-symbols-outlined text-base">smart_display</span>
                {t('teacher.builder.video')}
              </p>
              <input ref={videoInput} type="file" accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
                className="hidden" onChange={(e) => e.target.files?.[0] && uploadVideo(e.target.files[0])} />
              {videoPct != null ? (
                <div className="mb-4">
                  <p className="mb-1 text-xs text-outline">{t('teacher.builder.uploading', { pct: videoPct })}</p>
                  <ProgressBar pct={videoPct} tone="primary" />
                </div>
              ) : selected.videoAsset ? (
                <p className="mb-4 flex items-center justify-between rounded-lg bg-secondary-container/40 px-3 py-2 text-sm">
                  <span className="flex items-center gap-1 font-bold text-on-secondary-container">
                    <span className="material-symbols-outlined text-base">check_circle</span>
                    {t('teacher.builder.videoReady')}
                  </span>
                  <button className="text-primary hover:underline" onClick={() => videoInput.current?.click()}>
                    {t('teacher.builder.uploadVideo')}
                  </button>
                </p>
              ) : (
                <button
                  className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant py-3 text-sm text-on-surface-variant hover:border-primary hover:text-primary"
                  onClick={() => videoInput.current?.click()}
                >
                  <span className="material-symbols-outlined">upload</span>
                  {t('teacher.builder.uploadVideo')}
                </button>
              )}

              <Field label={t('teacher.builder.durationMin')}>
                <input className="input py-2" inputMode="numeric" value={durationMin}
                  onChange={(e) => setDurationMin(e.target.value.replace(/\D/g, ''))} />
              </Field>

              {/* Attachments */}
              <p className="mb-2 flex items-center gap-1 text-sm font-bold">
                <span className="material-symbols-outlined text-base">attach_file</span>
                {t('teacher.builder.attachments')}
              </p>
              <ul className="mb-2 space-y-1">
                {selected.attachments?.map((a: any) => (
                  <li key={a.id} className="flex items-center justify-between rounded-lg bg-surface-container-low px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="material-symbols-outlined text-base text-error">picture_as_pdf</span>
                      <span className="truncate" dir="auto">{a.fileName}</span>
                    </span>
                    <button className="text-outline hover:text-error" onClick={() => removeAttachment.mutate(a.id)}>
                      <span className="material-symbols-outlined text-base">close</span>
                    </button>
                  </li>
                ))}
              </ul>
              <input ref={fileInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.zip,.doc,.docx,.txt"
                className="hidden" onChange={(e) => e.target.files?.[0] && uploadAttachment(e.target.files[0])} />
              {filePct != null ? (
                <div className="mb-4">
                  <p className="mb-1 text-xs text-outline">{t('teacher.builder.uploading', { pct: filePct })}</p>
                  <ProgressBar pct={filePct} />
                </div>
              ) : (
                <button
                  className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant py-2.5 text-sm text-on-surface-variant hover:border-primary hover:text-primary"
                  onClick={() => fileInput.current?.click()}
                >
                  <span className="material-symbols-outlined text-base">upload_file</span>
                  {t('teacher.builder.uploadFile')}
                </button>
              )}

              <button className="btn-primary w-full" disabled={saveLesson.isPending} onClick={saveSettings}>
                {savedFlash ? t('teacher.builder.saved') + ' ✓' : t('teacher.builder.saveChanges')}
              </button>
              <ErrorNote error={saveLesson.error} />
            </div>
          ) : (
            <div className="card py-10 text-center text-sm text-outline">
              <span className="material-symbols-outlined mb-2 text-4xl text-outline-variant">tune</span>
              <p>{t('teacher.builder.settings')}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

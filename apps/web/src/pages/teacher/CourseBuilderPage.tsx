import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PlaybackTicket } from '@darsly/shared-types';
import { api, apiOrigin } from '../../lib/api';
import { imageToDataUrl } from '../../lib/image';
import { duration, egp } from '../../lib/format';
import { Badge, ErrorNote, ProgressBar, Spinner } from '../../components/ui';

/**
 * Course builder — the curriculum is the page, and a lesson opens in place.
 *
 * The settings used to sit in a sticky column on the side, so the lesson being
 * edited and the fields editing it were at opposite ends of the screen, and the
 * column kept its own scroll. Now a lesson expands underneath its own name:
 * description, video and release rules, all in the one place the teacher is
 * already looking. Adding is typing a name and pressing Enter.
 */
export default function CourseBuilderPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const queryClient = useQueryClient();

  // The open lesson is in the URL, not in component state.
  //
  // A teacher who opened a lesson's quiz and pressed back landed at the top of
  // the course with nothing selected — the browser restored the page, and the
  // page had forgotten everything. The address is the one piece of state that
  // survives leaving.
  const [params, setParams] = useSearchParams();
  const selectedLessonId = params.get('lesson');
  const setSelectedLessonId = (v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set('lesson', v);
    else next.delete('lesson');
    setParams(next, { replace: true });
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const [videoPct, setVideoPct] = useState<number | null>(null);
  const [filePct, setFilePct] = useState<number | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Lesson-settings drafts (per selected lesson)
  const [description, setDescription] = useState('');
  const [drip, setDrip] = useState<'now' | 'date' | 'days'>('now');
  const [dripDate, setDripDate] = useState('');
  const [dripDays, setDripDays] = useState('');
  const [freePreview, setFreePreview] = useState(false);

  // The open lesson's video, played back through the same signed-ticket flow a
  // student gets (teacher-owner bypass), so the teacher sees the real thing.
  const [previewTicket, setPreviewTicket] = useState<PlaybackTicket | null>(null);
  const [previewError, setPreviewError] = useState('');
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewHlsRef = useRef<Hls | null>(null);
  const previewSessionRef = useRef<string | null>(null);

  const videoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const thumbInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Unsaved lesson settings, kept until they are saved.
   *
   * Opening a lesson's quiz and coming back used to discard whatever had been
   * changed but not yet saved. It is held per lesson so switching between two
   * lessons does not mix them up, and cleared the moment a save succeeds.
   */
  const draftKey = (lessonId: string) => `darsly.lessonDraft.${lessonId}`;
  const readDraft = (lessonId: string) => {
    try {
      const raw = localStorage.getItem(draftKey(lessonId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const { data: course, isLoading } = useQuery({
    queryKey: ['teacher-course', id],
    queryFn: async () => (await api.get(`/teacher/courses/${id}`)).data,
    // A video keeps transcoding after the upload request already returned, so
    // while any lesson is still UPLOADING/PROCESSING, poll until it settles —
    // otherwise the panel is stuck showing "processing" long after it is ready.
    refetchInterval: (q) => {
      const c = q.state.data as any;
      const pending = c?.units?.some((u: any) =>
        u.lessons.some((l: any) => l.videoAsset && ['UPLOADING', 'PROCESSING'].includes(l.videoAsset.status)),
      );
      return pending ? 4000 : false;
    },
  });

  const units: any[] = course?.units ?? [];
  // Sections are opt-in: a course can be nothing but a flat list of lessons.
  // The default unit that holds them is never shown as a section itself.
  const defaultUnit = units.find((u: any) => u.isDefault) ?? null;
  const sections = units.filter((u: any) => !u.isDefault);
  const lessons: any[] = units.flatMap((u: any) => u.lessons);
  const selected = lessons.find((l: any) => l.id === selectedLessonId) ?? null;
  const selectedVideo = selected?.videoAsset ?? null;
  const selectedVideoId: string | null = selectedVideo?.id ?? null;
  const videoReady = selectedVideo?.status === 'READY';
  const totalSec = lessons.reduce((s: number, l: any) => s + (l.durationSec ?? 0), 0);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['teacher-course', id] });
    queryClient.invalidateQueries({ queryKey: ['teacher-courses'] });
  };

  const thumbUpload = useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await imageToDataUrl(file, { maxW: 960, maxH: 540, quality: 0.78 });
      return (await api.patch(`/teacher/courses/${id}/thumbnail`, { dataUrl })).data;
    },
    onSuccess: () => invalidate(),
  });

  const addUnit = useMutation({
    mutationFn: async (title: string) =>
      (await api.post(`/teacher/courses/${id}/units`, { title })).data,
    onSuccess: (unit) => {
      invalidate();
      setRenaming(`unit:${unit.id}`);
    },
  });
  const renameUnit = useMutation({
    mutationFn: async ({ unitId, title }: { unitId: string; title: string }) =>
      (await api.patch(`/teacher/units/${unitId}`, { title })).data,
    onSuccess: invalidate,
  });
  const removeUnit = useMutation({
    mutationFn: async (unitId: string) => (await api.delete(`/teacher/units/${unitId}`)).data,
    onSuccess: invalidate,
  });
  // The name is typed before the lesson exists now, so there is nothing left to
  // rename afterwards — it opens straight into its own details instead.
  const addLesson = useMutation({
    mutationFn: async ({ unitId, title }: { unitId: string; title: string }) =>
      (await api.post(`/teacher/units/${unitId}/lessons`, { title })).data,
    onSuccess: (lesson) => {
      invalidate();
      selectLesson(lesson);
    },
  });
  // No section chosen — lands in the hidden default unit the API creates on
  // first use. The same "type a name, press Enter" flow, one step shorter.
  const addLessonDirect = useMutation({
    mutationFn: async (title: string) =>
      (await api.post(`/teacher/courses/${id}/lessons`, { title })).data,
    onSuccess: (lesson) => {
      invalidate();
      selectLesson(lesson);
    },
  });
  const renameLesson = useMutation({
    mutationFn: async ({ lessonId, title }: { lessonId: string; title: string }) =>
      (await api.patch(`/teacher/lessons/${lessonId}`, { title })).data,
    onSuccess: invalidate,
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
      if (selectedLessonId) localStorage.removeItem(draftKey(selectedLessonId));
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

  const removeVideo = useMutation({
    mutationFn: async () => (await api.delete(`/teacher/lessons/${selectedLessonId}/video`)).data,
    onSuccess: invalidate,
  });

  // Ticket for whichever lesson is open, torn down when it closes or changes.
  useEffect(() => {
    if (!selectedLessonId || !videoReady) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post<PlaybackTicket>('/playback/sessions', { lessonId: selectedLessonId });
        if (cancelled) return;
        previewSessionRef.current = data.playbackSessionId;
        setPreviewTicket(data);
      } catch (e: any) {
        if (!cancelled) setPreviewError(e.response?.data?.message?.toString() ?? t('teacher.builder.previewError'));
      }
    })();
    return () => {
      cancelled = true;
      previewHlsRef.current?.destroy();
      previewHlsRef.current = null;
      if (previewSessionRef.current) {
        api.post(`/playback/sessions/${previewSessionRef.current}/end`).catch(() => {});
        previewSessionRef.current = null;
      }
      setPreviewTicket(null);
      setPreviewError('');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLessonId, selectedVideoId, videoReady]);

  // Attach HLS only once the ticket is back AND the <video> is mounted.
  useEffect(() => {
    if (!previewTicket || !previewVideoRef.current || previewHlsRef.current) return;
    const video = previewVideoRef.current;
    const masterUrl = `${apiOrigin()}${previewTicket.masterUrl}`;
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(masterUrl);
      hls.attachMedia(video);
      previewHlsRef.current = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = masterUrl;
    } else {
      setPreviewError(t('teacher.builder.previewError'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTicket]);

  /** Load a lesson into its panel — its unsaved draft wins if there is one. */
  function selectLesson(lesson: any) {
    setSelectedLessonId(lesson.id);
    applyLesson(lesson, readDraft(lesson.id));
  }

  function applyLesson(lesson: any, draft: any) {
    const src = draft ?? lesson;
    setFreePreview(!!src.isFreePreview);
    setDescription(src.description ?? '');
    if (draft) {
      setDrip(src.drip ?? 'now');
      setDripDate(src.dripDate ?? '');
      setDripDays(src.dripDays ?? '');
      return;
    }
    if (lesson.dripUnlockAt) {
      setDrip('date');
      setDripDate(String(lesson.dripUnlockAt).slice(0, 10));
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
      description: description.trim() || null,
      // durationSec is never sent from here — it is detected server-side from
      // the video itself once processing finishes, and must not be stomped by
      // a stale client value on an unrelated save.
      // Always reset the previous schedule, then apply the chosen mode.
      clearDrip: true,
      ...(drip === 'date' && dripDate
        ? { dripUnlockAt: new Date(dripDate).toISOString() }
        : drip === 'days'
          ? { dripAfterEnrollDays: Number(dripDays || 0) }
          : {}),
    });
  }

  // Every change to the panel is written down, so leaving the page for a quiz
  // and coming back finds the work still there.
  useEffect(() => {
    if (!selectedLessonId) return;
    localStorage.setItem(
      draftKey(selectedLessonId),
      JSON.stringify({ isFreePreview: freePreview, description, drip, dripDate, dripDays }),
    );
  }, [selectedLessonId, freePreview, description, drip, dripDate, dripDays]); // eslint-disable-line react-hooks/exhaustive-deps

  // Landing on the page with ?lesson=… — a back button, a bookmark, a reload —
  // opens that lesson rather than an empty panel.
  const hydrated = useRef<string | null>(null);
  useEffect(() => {
    if (!course || !selectedLessonId || hydrated.current === selectedLessonId) return;
    const lesson = lessons.find((l: any) => l.id === selectedLessonId);
    if (!lesson) return;
    hydrated.current = selectedLessonId;
    applyLesson(lesson, readDraft(selectedLessonId));
  }, [course, selectedLessonId]); // eslint-disable-line react-hooks/exhaustive-deps

  // …and puts it where you can see it. Coming back from a quiz should land on
  // the lesson you left, not at the top of a course with forty of them.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!course || !selectedLessonId || scrolledFor.current === selectedLessonId) return;
    scrolledFor.current = selectedLessonId;
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }, [course, selectedLessonId]);

  if (isLoading || !course) return <Spinner />;

  const isPublished = course.status === 'PUBLISHED';

  /** The lesson's own details, opened in place under its name. */
  const lessonPanel = !selected ? null : (
    <div
      ref={panelRef}
      className="mt-2 rounded-xl border border-primary-container bg-primary-fixed/25 p-4 sm:p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-outline-variant/60 pb-3">
        <p className="flex items-center gap-1.5 font-heading font-bold">
          <span className="material-symbols-outlined text-lg text-primary">tune</span>
          {t('teacher.builder.lessonDetails')}
        </p>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-outline transition hover:bg-surface-container-high hover:text-on-surface"
          title={t('teacher.builder.closePanel')}
          onClick={() => setSelectedLessonId(null)}
        >
          <span className="material-symbols-outlined text-lg">close</span>
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Left: what the lesson is, and the video itself */}
        <div className="min-w-0 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-bold">{t('teacher.builder.descLabel')}</label>
            <textarea
              className="input min-h-20"
              maxLength={1000}
              placeholder={t('teacher.builder.descPh')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">smart_display</span>
              {t('teacher.builder.video')}
            </p>
            <input
              ref={videoInput}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadVideo(e.target.files[0])}
            />

            {videoPct != null ? (
              <div className="rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-3">
                <p className="mb-1.5 text-xs font-bold text-on-surface-variant">
                  {t('teacher.builder.uploading', { pct: videoPct })}
                </p>
                <ProgressBar pct={videoPct} tone="primary" />
              </div>
            ) : !selectedVideo ? (
              <button
                className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-outline-variant py-8 text-sm text-on-surface-variant transition hover:border-primary hover:text-primary"
                onClick={() => videoInput.current?.click()}
              >
                <span className="material-symbols-outlined text-3xl">upload</span>
                {t('teacher.builder.uploadVideo')}
              </button>
            ) : selectedVideo.status === 'FAILED' ? (
              <div className="rounded-xl border border-error/30 bg-error-container/40 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-on-error-container">
                  <span className="material-symbols-outlined text-base">error</span>
                  {t('teacher.builder.videoFailed')}
                </p>
                <VideoActions
                  onReplace={() => videoInput.current?.click()}
                  onDelete={() => window.confirm(t('teacher.builder.videoDeleteConfirm')) && removeVideo.mutate()}
                  busy={removeVideo.isPending}
                  t={t}
                />
              </div>
            ) : selectedVideo.status !== 'READY' ? (
              <div className="rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-3">
                <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-on-surface-variant">
                  <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
                  {t('teacher.builder.videoProcessing')}
                </p>
                {/* Indeterminate: the transcoder reports no percentage, and a
                    fake one that stalls at 90% is worse than an honest pulse. */}
                <div className="skeleton mb-3 h-1.5 w-full rounded-full" />
                <VideoActions
                  onDelete={() => window.confirm(t('teacher.builder.videoDeleteConfirm')) && removeVideo.mutate()}
                  busy={removeVideo.isPending}
                  t={t}
                />
              </div>
            ) : (
              <div className="space-y-2">
                {previewError ? (
                  <ErrorNote error={{ message: previewError }} />
                ) : (
                  <video
                    ref={previewVideoRef}
                    controls
                    controlsList="nodownload"
                    className="aspect-video w-full rounded-xl bg-black"
                  />
                )}
                <p className="flex items-center gap-1.5 text-xs font-bold text-secondary">
                  <span className="material-symbols-outlined text-sm">check_circle</span>
                  {t('teacher.builder.videoReady')}
                  {selected!.durationSec > 0 && (
                    <span className="font-normal text-outline">
                      · {t('teacher.builder.videoDuration', { time: duration(selected!.durationSec) })}
                    </span>
                  )}
                </p>
                <VideoActions
                  onReplace={() => videoInput.current?.click()}
                  onDelete={() => window.confirm(t('teacher.builder.videoDeleteConfirm')) && removeVideo.mutate()}
                  busy={removeVideo.isPending}
                  t={t}
                />
              </div>
            )}
            <ErrorNote error={removeVideo.error} />
          </div>
        </div>

        {/* Right: when it opens, who sees it, and what comes with it */}
        <div className="min-w-0 space-y-4">
          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">lock_clock</span>
              {t('teacher.builder.drip')}
            </p>
            <div className="space-y-2">
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'now' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}>
                <input type="radio" className="mt-1 accent-primary" checked={drip === 'now'} onChange={() => setDrip('now')} />
                <span>
                  <span className="block text-sm font-bold">{t('teacher.builder.dripImmediate')}</span>
                  <span className="text-xs text-outline">{t('teacher.builder.dripImmediateHint')}</span>
                </span>
              </label>
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'date' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}>
                <input type="radio" className="mt-1 accent-primary" checked={drip === 'date'} onChange={() => setDrip('date')} />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{t('teacher.builder.dripDate')}</span>
                  {drip === 'date' && (
                    <input type="date" className="input mt-2 py-1.5 text-sm" value={dripDate}
                      onChange={(e) => setDripDate(e.target.value)} />
                  )}
                </span>
              </label>
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'days' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}>
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
          </div>

          <div>
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
            <p className="text-xs text-outline">{t('teacher.builder.freePreviewHint')}</p>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">quiz</span>
              {t('assess.builder.section')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {/* `?course=` so the back link there returns to this lesson. */}
              <Link to={`/teacher/lessons/${selected!.id}/quiz?course=${id}`}
                className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary">
                <span className="material-symbols-outlined text-base">quiz</span>
                {t('assess.builder.editQuiz')}
              </Link>
              <Link to={`/teacher/lessons/${selected!.id}/assignment?course=${id}`}
                className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary">
                <span className="material-symbols-outlined text-base">assignment</span>
                {t('assess.builder.editAssignment')}
              </Link>
            </div>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">attach_file</span>
              {t('teacher.builder.attachments')}
            </p>
            <ul className="mb-2 space-y-1">
              {selected!.attachments?.map((a: any) => (
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
              <div>
                <p className="mb-1 text-xs text-outline">{t('teacher.builder.uploading', { pct: filePct })}</p>
                <ProgressBar pct={filePct} />
              </div>
            ) : (
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-outline-variant py-2.5 text-sm text-on-surface-variant transition hover:border-primary hover:text-primary"
                onClick={() => fileInput.current?.click()}
              >
                <span className="material-symbols-outlined text-base">upload_file</span>
                {t('teacher.builder.uploadFile')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-outline-variant/60 pt-4">
        {/* Held in the browser until it is saved, so leaving this page for a
            quiz and coming back does not lose the work. */}
        <p className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          {savedFlash ? (
            <>
              <span className="material-symbols-outlined text-[14px] text-secondary">cloud_done</span>
              {t('teacher.builder.saved')}
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[14px]">cloud_off</span>
              {t('teacher.builder.unsaved')}
            </>
          )}
        </p>
        <button className="btn-primary px-6" disabled={saveLesson.isPending} onClick={saveSettings}>
          {t('teacher.builder.saveChanges')}
        </button>
      </div>
      <ErrorNote error={saveLesson.error} />
    </div>
  );

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="mb-1 flex items-center gap-1 text-sm text-outline">
            <Link to="/teacher/courses" className="text-primary hover:underline">
              {t('teacher.builder.back')}
            </Link>
            <span className="material-symbols-outlined text-sm rtl:-scale-x-100">chevron_left</span>
            <span>{course.title}</span>
          </p>
          <h1 className="font-heading text-4xl font-extrabold">{t('teacher.builder.title')}</h1>
          <p className="mt-2 text-on-surface-variant">{t('teacher.builder.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={isPublished ? 'teal' : 'warn'}>
            {isPublished ? t('teacher.builder.published') : t('teacher.builder.draft')}
          </Badge>
          {/* Publishing lives at the end of the curriculum, where a teacher is
              standing once the lessons are in. Up here it only appears once the
              course is already live, to push later edits out. */}
          {isPublished && (
            <button className="btn-secondary py-2 text-sm" disabled={publish.isPending} onClick={() => publish.mutate('PUBLISHED')}>
              <span className="material-symbols-outlined text-[20px]">publish</span>
              {t('teacher.builder.republish')}
            </button>
          )}
        </div>
      </div>
      {publish.error && <PublishError error={publish.error} t={t} />}

      {/* Course cover / thumbnail */}
      <div className="mb-5 overflow-hidden rounded-2xl border border-outline-variant/50">
        <div className="relative h-44 bg-surface-container-high sm:h-56">
          {course.thumbnailUrl ? (
            <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-outline">
              <span className="material-symbols-outlined text-5xl">image</span>
            </div>
          )}
          <input ref={thumbInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={(e) => e.target.files?.[0] && thumbUpload.mutate(e.target.files[0])} />
          <button
            className="absolute end-3 bottom-3 flex items-center gap-1.5 rounded-xl bg-surface-container-lowest/90 px-3 py-2 text-sm font-bold text-primary shadow-card backdrop-blur transition hover:bg-surface-container-lowest"
            disabled={thumbUpload.isPending}
            onClick={() => thumbInput.current?.click()}
          >
            <span className="material-symbols-outlined text-base">{thumbUpload.isPending ? 'hourglass' : 'photo_camera'}</span>
            {thumbUpload.isPending ? t('common.saving') : t('teacher.builder.changeCover')}
          </button>
        </div>
      </div>
      <ErrorNote error={thumbUpload.error} />

      {/* Summary strip — what used to be the pricing card in the side column. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-outline-variant/60 bg-surface-container-lowest px-4 py-3">
        <p className="text-sm text-on-surface-variant">
          {t('teacher.builder.countSummary', { lessons: lessons.length, time: duration(totalSec) })}
        </p>
        <p className="flex items-baseline gap-2 text-sm text-on-surface-variant">
          <span>{t(`teacher.courses.form.${course.pricingModel === 'ONE_TIME' ? 'oneTime' : course.pricingModel === 'MONTHLY_SUBSCRIPTION' ? 'monthly' : 'bundle'}`)}</span>
          <span className="font-heading text-xl font-extrabold text-on-surface">
            {egp(course.priceCents)}
            {course.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
              <span className="text-xs font-normal text-outline">/{t('course.perMonth')}</span>
            )}
          </span>
        </p>
      </div>

      {/* Curriculum — full width, lessons open in place.
          Sections are opt-in: lessons can sit right here with no section at
          all, or be grouped into named ones below — both at once, even. */}
      <div className="card mb-5 p-5">
        <div className="mb-4 flex items-center gap-3">
          <p className="font-heading text-lg font-bold">{t('teacher.builder.directLessons')}</p>
          {defaultUnit?.lessons.length > 0 && (
            <span className="ms-auto shrink-0 text-sm text-on-surface-variant">
              {t('teacher.builder.lessonsMeta', { count: defaultUnit.lessons.length })}
            </span>
          )}
        </div>

        {defaultUnit?.lessons.length > 0 && (
          <ul className="mb-3 space-y-2">
            {defaultUnit.lessons.map((l: any, li: number) => (
              <LessonRow
                key={l.id}
                l={l}
                li={li}
                open={selectedLessonId === l.id}
                onToggle={() => (selectedLessonId === l.id ? setSelectedLessonId(null) : selectLesson(l))}
                editingTitle={renaming === `lesson:${l.id}`}
                onEdit={() => setRenaming(`lesson:${l.id}`)}
                onRename={(title) => {
                  setRenaming(null);
                  if (title && title !== l.title) renameLesson.mutate({ lessonId: l.id, title });
                }}
                onDelete={() => window.confirm(t('teacher.builder.deleteLessonConfirm')) && removeLesson.mutate(l.id)}
                panel={lessonPanel}
                t={t}
              />
            ))}
          </ul>
        )}

        <AddLessonRow
          busy={addLessonDirect.isPending}
          placeholder={t('teacher.builder.lessonNamePh')}
          label={t('teacher.builder.addLessonCta')}
          onAdd={(title) => addLessonDirect.mutate(title)}
        />
      </div>

      {sections.length > 0 && (
        <div className="mb-5 space-y-5">
          {sections.map((u: any, ui: number) => (
            <div key={u.id} className="card p-5">
              <div className="group/unit mb-4 flex items-center gap-3">
                <Badge>{t('teacher.builder.unitBadge', { n: ui + 1 })}</Badge>
                <InlineName
                  value={u.title}
                  editing={renaming === `unit:${u.id}`}
                  onEdit={() => setRenaming(`unit:${u.id}`)}
                  onDone={(title) => {
                    setRenaming(null);
                    if (title && title !== u.title) renameUnit.mutate({ unitId: u.id, title });
                  }}
                  className="font-heading text-lg font-bold"
                />
                <span className="ms-auto shrink-0 text-sm text-on-surface-variant">
                  {t('teacher.builder.lessonsMeta', { count: u.lessons.length })}
                </span>
                <button
                  title={t('common.delete')}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline opacity-0 transition hover:bg-error-container hover:text-on-error-container focus-visible:opacity-100 group-hover/unit:opacity-100"
                  onClick={() => window.confirm(t('teacher.builder.deleteUnitConfirm')) && removeUnit.mutate(u.id)}
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
              </div>

              <ul className="space-y-2">
                {u.lessons.map((l: any, li: number) => (
                  <LessonRow
                    key={l.id}
                    l={l}
                    li={li}
                    open={selectedLessonId === l.id}
                    onToggle={() => (selectedLessonId === l.id ? setSelectedLessonId(null) : selectLesson(l))}
                    editingTitle={renaming === `lesson:${l.id}`}
                    onEdit={() => setRenaming(`lesson:${l.id}`)}
                    onRename={(title) => {
                      setRenaming(null);
                      if (title && title !== l.title) renameLesson.mutate({ lessonId: l.id, title });
                    }}
                    onDelete={() => window.confirm(t('teacher.builder.deleteLessonConfirm')) && removeLesson.mutate(l.id)}
                    panel={lessonPanel}
                    t={t}
                  />
                ))}
              </ul>

              {/* Type a name, press Enter, keep going. */}
              <AddLessonRow
                busy={addLesson.isPending}
                placeholder={t('teacher.builder.lessonNamePh')}
                label={t('teacher.builder.addLessonCta')}
                onAdd={(title) => addLesson.mutate({ unitId: u.id, title })}
              />
            </div>
          ))}
        </div>
      )}

      <button
        className="btn-secondary w-full py-3"
        disabled={addUnit.isPending}
        onClick={() => addUnit.mutate(t('teacher.builder.newUnitName', { n: sections.length + 1 }))}
      >
        <span className="material-symbols-outlined text-[20px]">add</span>
        {t('teacher.builder.addUnit')}
      </button>

      {/* Publishing, always reachable — no reason to leave the page for it. */}
      <div className="card mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-heading text-lg font-bold">
            {isPublished ? t('teacher.builder.publishedTitle') : t('teacher.builder.publishTitle')}
          </p>
          <p className="mt-1 text-sm text-on-surface-variant">
            {isPublished ? t('teacher.builder.publishedHint') : t('teacher.builder.publishHint')}
          </p>
        </div>
        {isPublished ? (
          <button className="btn-secondary" disabled={publish.isPending} onClick={() => publish.mutate('DRAFT')}>
            <span className="material-symbols-outlined text-[20px]">visibility_off</span>
            {t('teacher.builder.unpublish')}
          </button>
        ) : (
          <button className="btn-primary px-7 py-3" disabled={publish.isPending} onClick={() => publish.mutate('PUBLISHED')}>
            <span className="material-symbols-outlined text-[20px]">publish</span>
            {t('teacher.builder.publishNow')}
          </button>
        )}
      </div>
      {publish.error && <PublishError error={publish.error} t={t} />}
    </div>
  );
}

/** A publish failure the teacher can actually read — "no lessons yet" gets
 *  its own line; anything else falls back to whatever the server said. */
function PublishError({ error, t }: { error: unknown; t: (k: string) => string }) {
  const data = (error as any)?.response?.data;
  const text = data?.code === 'NO_LESSONS' ? t('teacher.builder.noLessonsToPublish') : data?.message;
  return (
    <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
      {text || t('common.error')}
    </p>
  );
}

/** Replace / delete, shared by every state a video can be in. */
function VideoActions({
  onReplace, onDelete, busy, t,
}: {
  onReplace?: () => void;
  onDelete: () => void;
  busy: boolean;
  t: (k: string) => string;
}) {
  return (
    <div className="flex gap-2 text-sm font-bold">
      {onReplace && (
        <button
          className="flex-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2 text-on-surface-variant transition hover:border-primary hover:text-primary"
          onClick={onReplace}
        >
          {t('teacher.builder.videoReplace')}
        </button>
      )}
      <button
        className="flex-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2 text-error transition hover:border-error"
        disabled={busy}
        onClick={onDelete}
      >
        {t('teacher.builder.videoDelete')}
      </button>
    </div>
  );
}

/**
 * One row in the curriculum — a lesson's name, type icon, badges and delete
 * button, expanding into its settings panel when open. The same row is used
 * whether the lesson sits directly in the course or inside a named section;
 * only where the list comes from differs.
 */
function LessonRow({
  l, li, open, onToggle, editingTitle, onEdit, onRename, onDelete, panel, t,
}: {
  l: any;
  li: number;
  open: boolean;
  onToggle: () => void;
  editingTitle: boolean;
  onEdit: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  panel: ReactNode;
  t: (k: string, o?: any) => string;
}) {
  return (
    <li>
      <div
        className={`group/lesson flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
          open
            ? 'border-primary-container bg-primary-fixed/40'
            : 'border-outline-variant/40 bg-surface-container-lowest hover:bg-surface-container-low'
        }`}
        onClick={onToggle}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
          <span className="material-symbols-outlined text-xl">
            {l.type === 'QUIZ' ? 'quiz' : l.type === 'ASSIGNMENT' ? 'assignment' : l.videoAsset ? 'play_circle' : 'draft'}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-bold">
            <span className="shrink-0 text-outline">{li + 1}.</span>
            <InlineName value={l.title} editing={editingTitle} onEdit={onEdit} onDone={onRename} />
          </p>
          <p className="flex flex-wrap gap-2 text-xs text-outline">
            {l.durationSec > 0 && <span>{duration(l.durationSec)}</span>}
            {l.videoAsset && ['UPLOADING', 'PROCESSING'].includes(l.videoAsset.status) && (
              <span className="text-primary">{t('teacher.builder.videoProcessing')}</span>
            )}
            {l.isFreePreview && <span className="text-secondary">{t('teacher.builder.freePreview')}</span>}
            {(l.dripUnlockAt || l.dripAfterEnrollDays != null) && (
              <span className="flex items-center gap-0.5">
                <span className="material-symbols-outlined text-xs">lock_clock</span>
                Drip
              </span>
            )}
            {l.attachments?.length > 0 && <span>{t('course.attachmentsCount', { count: l.attachments.length })}</span>}
          </p>
        </div>
        <span className={`material-symbols-outlined shrink-0 text-outline transition ${open ? 'rotate-180' : ''}`}>
          expand_more
        </span>
        <button
          title={t('common.delete')}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline opacity-0 transition hover:bg-error-container hover:text-on-error-container focus-visible:opacity-100 group-hover/lesson:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <span className="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
      {open && panel}
    </li>
  );
}

/**
 * Add a lesson by naming it.
 *
 * The old flow made a lesson called "Lesson 3" and then put you in a rename
 * box, which is two steps to do one thing. Type the name, press Enter, the
 * lesson exists and opens — and the box is empty and focused for the next one.
 */
function AddLessonRow({
  onAdd, busy, placeholder, label,
}: {
  onAdd: (title: string) => void;
  busy: boolean;
  placeholder: string;
  label: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  const submit = () => {
    const title = value.trim();
    if (!title || busy) return;
    onAdd(title);
    setValue('');
    ref.current?.focus();
  };

  return (
    <div className="mt-3 flex items-center gap-2 rounded-xl border-2 border-dashed border-outline-variant px-3 py-1.5 transition focus-within:border-primary">
      <span className="material-symbols-outlined text-outline">add</span>
      <input
        ref={ref}
        className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-outline"
        placeholder={placeholder}
        maxLength={200}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-bold text-primary transition hover:bg-primary-fixed disabled:opacity-40"
        disabled={!value.trim() || busy}
        onClick={submit}
      >
        {label}
      </button>
    </div>
  );
}

/**
 * A name you edit where it sits.
 *
 * Adding used to mean filling a form before anything existed. Now the thing is
 * created with a sensible name and this is how you change it if you want to —
 * click, type, Enter. Escape puts it back.
 */
function InlineName({
  value, editing, onEdit, onDone, className = '',
}: {
  value: string;
  editing: boolean;
  onEdit: () => void;
  onDone: (title: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        title={value}
        className={`min-w-0 truncate rounded-md px-1 text-start transition hover:bg-surface-container-high ${className}`}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      className={`min-w-0 flex-1 rounded-md border border-primary bg-surface-container-lowest px-1.5 py-0.5 outline-none ${className}`}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(draft.trim());
        if (e.key === 'Escape') onDone('');
      }}
    />
  );
}

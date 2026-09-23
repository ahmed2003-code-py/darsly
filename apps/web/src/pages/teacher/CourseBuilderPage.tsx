import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UploadPanel } from '../../components/UploadPanel';
import { DeleteButton } from '../../components/DeleteButton';
import Hls from 'hls.js';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PlaybackTicket } from '@darsly/shared-types';
import { api, apiOrigin } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { imageToDataUrl } from '../../lib/image';
import { duration, egp } from '../../lib/format';
import { Badge, ErrorNote, Modal, Spinner } from '../../components/ui';
import { MarkdownEditor } from '../../components/MarkdownEditor';

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
  /**
   * Which sections are folded away.
   *
   * A nine-lesson course ran four screens deep, and every section repeated its
   * own add row and import link whether or not anyone was looking at it. Folded
   * sections turn that into a table of contents a teacher can actually read,
   * and the choice is remembered so their shape survives a reload.
   */
  const foldKey = `darsly.builderFolded.${id}`;
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(foldKey);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set<string>();
    }
  });
  const toggleFold = (unitId: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      try {
        localStorage.setItem(foldKey, JSON.stringify([...next]));
      } catch {
        // Not remembered, still folded — this view honours the click either way.
      }
      return next;
    });

  const [videoPct, setVideoPct] = useState<number | null>(null);
  /**
   * What is going up, and the handle to stop it.
   *
   * The bar knew a percentage and nothing else — not the name of the file, not
   * its size, and crucially no way to abort. A teacher who picked the wrong
   * 400MB video had to sit and watch it finish.
   */
  const [videoUp, setVideoUp] = useState<{ name: string; size: number } | null>(null);
  const videoAbort = useRef<AbortController | null>(null);
  // Which lesson the upload belongs to. Without it the bar followed whichever
  // lesson happened to be open, so opening a second one while a video uploaded
  // showed that lesson filling up with someone else's progress.
  const [uploadingLessonId, setUploadingLessonId] = useState<string | null>(null);
  // Read by the poll, which runs outside React's render and must not be a
  // render behind on whether a file is currently going up.
  const uploadingRef = useRef(false);
  const [filePct, setFilePct] = useState<number | null>(null);
  const [fileUp, setFileUp] = useState<{ name: string; size: number } | null>(null);
  const fileAbort = useRef<AbortController | null>(null);
  // The course's own intro clip, which is marketing rather than a lesson and so
  // has its own upload, its own progress, and its own errors.
  const [introPct, setIntroPct] = useState<number | null>(null);
  const [introError, setIntroError] = useState<unknown>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Lesson-settings drafts (per selected lesson)
  const [description, setDescription] = useState('');
  const [title, setTitle] = useState('');
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
  const introInput = useRef<HTMLInputElement>(null);
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

  /**
   * Naming this lesson as the course's exam or its assignment.
   *
   * A `PATCH` on the course rather than on the lesson, because the course is
   * what holds the answer — and holding it in one column is what makes it one
   * exam per course instead of one per lesson.
   */
  const setRole = useMutation({
    mutationFn: async (patch: {
      examLessonId?: string | null;
      assignmentLessonId?: string | null;
      examMode?: 'GATE' | 'FINAL';
    }) => (await api.patch(`/teacher/courses/${id}`, patch)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teacher-course', id] }),
  });

  const { data: course, isLoading } = useQuery({
    queryKey: ['teacher-course', id],
    queryFn: async () => (await api.get(`/teacher/courses/${id}`)).data,
    // A video keeps transcoding after the upload request already returned, so
    // while any lesson is still UPLOADING/PROCESSING, poll until it settles —
    // otherwise the panel is stuck showing "processing" long after it is ready.
    refetchInterval: (q) => {
      const c = q.state.data as any;
      const pending = c?.units?.some((u: any) =>
        u.lessons.some(
          (l: any) => l.videoAsset && ['UPLOADING', 'PROCESSING'].includes(l.videoAsset.status),
        ),
      );
      if (!pending) return false;
      // Backed off while a file is going up. This poll watches transcoding,
      // which has not started yet — all it does during an upload is take
      // bandwidth from it and re-render the page that is drawing the progress.
      return uploadingRef.current ? 15000 : 4000;
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
  /** What is left to do across the whole course, which is the teacher's question. */
  const missingVideo = lessons.filter((l: any) => !l.videoAsset && l.type === 'VIDEO').length;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['teacher-course', id] });
    queryClient.invalidateQueries({ queryKey: ['teacher-courses'] });
  };

  /**
   * Show the new lesson now, reconcile after.
   *
   * The server already handed back the row it created, so waiting for a full
   * refetch of the course before drawing it buys nothing — and during a video
   * upload that refetch queues behind the upload on the same connection, which
   * is why adding a lesson felt like it had not worked until it suddenly did.
   * The cache is updated from the response and the refetch still runs, so a
   * server-side detail we did not receive is picked up a moment later.
   */
  const insertLesson = (lesson: any, intoNewDefaultUnit = false) => {
    queryClient.setQueryData(['teacher-course', id], (prev: any) => {
      if (!prev?.units) return prev;
      const unit = prev.units.find((u: any) => u.id === lesson.unitId);
      if (unit) {
        if (unit.lessons.some((l: any) => l.id === lesson.id)) return prev;
        return {
          ...prev,
          units: prev.units.map((u: any) =>
            u.id === lesson.unitId ? { ...u, lessons: [...u.lessons, lesson] } : u,
          ),
        };
      }
      // The very first lesson in a course: the API made the hidden default unit
      // to hold it, and we have never seen it. Only assumed for the path that
      // targets that unit by definition — a section we do not know about is
      // left to the refetch rather than guessed at.
      if (!intoNewDefaultUnit) return prev;
      return {
        ...prev,
        units: [
          ...prev.units,
          { id: lesson.unitId, title: '', isDefault: true, lessons: [lesson] },
        ],
      };
    });
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
      // Drawn from the response for the same reason a lesson is: the section
      // exists, and making the teacher wait for a refetch to believe it is how
      // a click starts feeling like it did nothing.
      queryClient.setQueryData(['teacher-course', id], (prev: any) =>
        prev?.units && !prev.units.some((u: any) => u.id === unit.id)
          ? { ...prev, units: [...prev.units, { ...unit, lessons: [] }] }
          : prev,
      );
      setRenaming(`unit:${unit.id}`);
      invalidate();
    },
  });
  // Clicks that land while the page is busy must not each become a section —
  // they would also all be numbered the same, since the name counts what
  // exists at the moment of the click.
  const addSection = useOnce(addUnit.isPending);
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
      insertLesson(lesson);
      selectLesson(lesson);
      invalidate();
    },
  });
  // No section chosen — lands in the hidden default unit the API creates on
  // first use. The same "type a name, press Enter" flow, one step shorter.
  const addLessonDirect = useMutation({
    mutationFn: async (title: string) =>
      (await api.post(`/teacher/courses/${id}/lessons`, { title })).data,
    onSuccess: (lesson) => {
      insertLesson(lesson, true);
      selectLesson(lesson);
      invalidate();
    },
  });
  // Bulk import — paste several YouTube links, get several lessons. The
  // target (a section, or none) is fixed when the modal opens from wherever
  // it was triggered; one release setting and one paid/free setting apply
  // to the whole batch, same as the single-lesson add did before it existed.
  const [importOpen, setImportOpen] = useState(false);
  const [importUnitId, setImportUnitId] = useState<string | undefined>(undefined);
  // One field per link — "فيديو 1", "فيديو 2"… — not one box to paste a block
  // into, so a single bad link is easy to spot and fix without hunting for it.
  const [importUrls, setImportUrls] = useState<string[]>(['']);
  const [importFreePreview, setImportFreePreview] = useState(false);
  const [importDrip, setImportDrip] = useState<'now' | 'date' | 'days'>('now');
  const [importDripDate, setImportDripDate] = useState('');
  const [importDripDays, setImportDripDays] = useState('');

  function openImport(unitId?: string) {
    setImportUnitId(unitId);
    setImportUrls(['']);
    setImportFreePreview(false);
    setImportDrip('now');
    setImportDripDate('');
    setImportDripDays('');
    importYoutube.reset();
    setImportOpen(true);
  }
  const setImportUrlAt = (i: number, value: string) =>
    setImportUrls((prev) => prev.map((u, idx) => (idx === i ? value : u)));
  const addImportUrl = () => setImportUrls((prev) => [...prev, '']);
  const removeImportUrl = (i: number) =>
    setImportUrls((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const importYoutube = useMutation({
    mutationFn: async () => {
      const urls = importUrls.map((s) => s.trim()).filter(Boolean);
      return (
        await api.post(`/teacher/courses/${id}/lessons/import-youtube`, {
          urls,
          ...(importUnitId ? { unitId: importUnitId } : {}),
          isFreePreview: importFreePreview,
          ...(importDrip === 'date' && importDripDate
            ? { dripUnlockAt: new Date(importDripDate).toISOString() }
            : importDrip === 'days'
              ? { dripAfterEnrollDays: Number(importDripDays || 0) }
              : {}),
        })
      ).data as {
        results: {
          url: string;
          lesson?: { title: string };
          error?: 'INVALID_URL' | 'METADATA_FAILED';
          detail?: string;
        }[];
      };
    },
    // A fully clean run closes the modal outright — nothing left to review.
    // A partial failure keeps it open but drops the succeeded links from the
    // fields, leaving only the ones that need fixing: otherwise they sit
    // there looking untouched and inviting a second "استيراد" press that
    // would import the same working links again as duplicate lessons.
    onSuccess: (data) => {
      invalidate();
      const failedUrls = data.results.filter((r) => r.error).map((r) => r.url);
      if (failedUrls.length === 0) setImportOpen(false);
      else setImportUrls(failedUrls);
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

  /**
   * Report progress without repainting the page for every packet.
   *
   * A browser fires upload progress many times a second, and this percentage
   * lives on the whole builder — so a large video meant the entire tree
   * re-rendering continuously for minutes. The page stopped answering clicks,
   * the ones that were queued all arrived at once, and a teacher who pressed
   * Enter twice got two lessons. Only whole-percent changes are published, so
   * a two-minute upload costs a hundred renders instead of thousands.
   */
  function throttledPct(set: (v: number | null) => void) {
    let last = -1;
    return (e: { loaded: number; total?: number }, size: number) => {
      const pct = Math.round((e.loaded / (e.total ?? size)) * 100);
      if (pct === last) return;
      last = pct;
      set(pct);
    };
  }

  const [videoError, setVideoError] = useState<unknown>(null);

  async function uploadVideo(file: File) {
    // Which lesson this belongs to is decided now, not when the upload lands:
    // the teacher is free to open another lesson while it runs, and the video
    // has to arrive where they started it.
    const lessonId = selectedLessonId;
    if (!lessonId) return;
    setVideoPct(0);
    setVideoUp({ name: file.name, size: file.size });
    setUploadingLessonId(lessonId);
    uploadingRef.current = true;
    const onPct = throttledPct(setVideoPct);
    setVideoError(null);
    const ac = new AbortController();
    videoAbort.current = ac;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data: asset } = await api.post('/uploads/videos', fd, {
        onUploadProgress: (e) => onPct(e, file.size),
        signal: ac.signal,
      });
      await api.patch(`/teacher/lessons/${lessonId}`, { videoAssetId: asset.id });
      invalidate();
    } catch (err) {
      // `finally` used to clear the progress bar and let the error go, so a
      // refused file — too large, wrong type, a network that dropped — put the
      // page back to "upload a video" as though nothing had been attempted.
      // Silence is the worst of the three possible answers.
      // Cancelling is a decision, not a failure: saying "upload failed" to
      // somebody who just pressed stop is the app arguing with them.
      if (!ac.signal.aborted) setVideoError(err);
    } finally {
      uploadingRef.current = false;
      videoAbort.current = null;
      setVideoPct(null);
      setVideoUp(null);
      setUploadingLessonId(null);
    }
  }

  /**
   * Upload the course's intro clip.
   *
   * It goes up whole rather than through the lesson pipeline: it is a public
   * MP4 a visitor watches before they have paid for anything, so there is
   * nothing to encrypt and nothing to gate. Progress is reported because the
   * file is large enough that silence reads as a hang.
   */
  const INTRO_MAX_MB = 50;
  async function uploadIntro(file: File) {
    // Checked here as well as on the server, because the server can only answer
    // after the whole file has gone up — and being told a 200 MB clip is too
    // big once it has finished uploading is the worst possible time to hear it.
    if (file.type !== 'video/mp4') {
      setIntroError(new Error(t('teacher.builder.introFormatErr')));
      return;
    }
    if (file.size > INTRO_MAX_MB * 1024 * 1024) {
      setIntroError(new Error(t('teacher.builder.introSizeErr', { mb: INTRO_MAX_MB })));
      return;
    }
    setIntroError(null);
    setIntroPct(0);
    uploadingRef.current = true;
    const onPct = throttledPct(setIntroPct);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/teacher/courses/${id}/intro-video`, fd, {
        onUploadProgress: (e) => onPct(e, file.size),
      });
      invalidate();
    } catch (err) {
      setIntroError(err);
    } finally {
      uploadingRef.current = false;
      setIntroPct(null);
    }
  }

  const removeIntro = useMutation({
    mutationFn: async () => (await api.delete(`/teacher/courses/${id}/intro-video`)).data,
    onSuccess: invalidate,
  });

  async function uploadAttachment(file: File) {
    const lessonId = selectedLessonId;
    if (!lessonId) return;
    setFilePct(0);
    setFileUp({ name: file.name, size: file.size });
    uploadingRef.current = true;
    const onPct = throttledPct(setFilePct);
    const ac = new AbortController();
    fileAbort.current = ac;
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/uploads/lessons/${lessonId}/attachments`, fd, {
        onUploadProgress: (e) => onPct(e, file.size),
        signal: ac.signal,
      });
      invalidate();
    } finally {
      uploadingRef.current = false;
      fileAbort.current = null;
      setFilePct(null);
      setFileUp(null);
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
        const { data } = await api.post<PlaybackTicket>('/playback/sessions', {
          lessonId: selectedLessonId,
        });
        if (cancelled) return;
        previewSessionRef.current = data.playbackSessionId;
        setPreviewTicket(data);
      } catch (e: any) {
        if (!cancelled)
          setPreviewError(
            e.response?.data?.message?.toString() ?? t('teacher.builder.previewError'),
          );
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
    // Always the real name, never a draft's: renaming is saved with the panel,
    // and a half-typed name left over from an unsaved visit would look like
    // the lesson had already been renamed.
    setTitle(lesson.title ?? '');
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
      ...(title.trim() && title.trim() !== selected?.title ? { title: title.trim() } : {}),
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
    requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
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
          {/* The name lives here rather than as a third button on the row. At
              phone width those buttons left "الدرس ا…" of the title, and this
              is where a teacher is already editing the lesson anyway. */}
          <div>
            <label className="mb-1.5 block text-sm font-bold" htmlFor="lesson-title">
              {t('teacher.builder.titleLabel')}
            </label>
            <input
              id="lesson-title"
              className="input"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-bold">
              {t('teacher.builder.descLabel')}
            </label>
            <MarkdownEditor
              id="lesson-description"
              minHeight="min-h-20"
              maxLength={1000}
              value={description}
              onChange={setDescription}
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

            {videoError != null && <ErrorNote error={videoError} />}

            {videoPct != null && uploadingLessonId === selectedLessonId ? (
              <UploadPanel
                phase="uploading"
                pct={videoPct}
                fileName={videoUp?.name}
                fileSize={videoUp?.size}
                onCancel={() => videoAbort.current?.abort()}
              />
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
                  onDelete={async () =>
                    (await askConfirm(t('teacher.builder.videoDeleteConfirm'))) &&
                    removeVideo.mutate()
                  }
                  busy={removeVideo.isPending}
                  t={t}
                />
              </div>
            ) : selectedVideo.status !== 'READY' ? (
              <div className="space-y-3">
                {/* Indeterminate on purpose: the transcoder reports no
                    percentage, and a fake one that stalls at 90% is worse than
                    an honest sweep — see UploadPanel. */}
                <UploadPanel phase="working" note={t('teacher.builder.videoProcessing')} />
                <VideoActions
                  onDelete={async () =>
                    (await askConfirm(t('teacher.builder.videoDeleteConfirm'))) &&
                    removeVideo.mutate()
                  }
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
                      ·{' '}
                      {t('teacher.builder.videoDuration', {
                        time: duration(selected!.durationSec),
                      })}
                    </span>
                  )}
                </p>
                <VideoActions
                  onReplace={() => videoInput.current?.click()}
                  onDelete={async () =>
                    (await askConfirm(t('teacher.builder.videoDeleteConfirm'))) &&
                    removeVideo.mutate()
                  }
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
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'now' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={drip === 'now'}
                  onChange={() => setDrip('now')}
                />
                <span>
                  <span className="block text-sm font-bold">
                    {t('teacher.builder.dripImmediate')}
                  </span>
                  <span className="text-xs text-outline">
                    {t('teacher.builder.dripImmediateHint')}
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'date' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={drip === 'date'}
                  onChange={() => setDrip('date')}
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{t('teacher.builder.dripDate')}</span>
                  {drip === 'date' && (
                    <input
                      type="date"
                      className="input mt-2 py-1.5 text-sm"
                      value={dripDate}
                      onChange={(e) => setDripDate(e.target.value)}
                    />
                  )}
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${drip === 'days' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50 bg-surface-container-lowest'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={drip === 'days'}
                  onChange={() => setDrip('days')}
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{t('teacher.builder.dripDays')}</span>
                  {drip === 'days' && (
                    <span className="mt-2 flex items-center gap-2">
                      <input
                        className="input w-20 py-1.5 text-sm"
                        inputMode="numeric"
                        value={dripDays}
                        onChange={(e) => setDripDays(e.target.value.replace(/\D/g, ''))}
                      />
                      <span className="text-xs text-outline">
                        {t('teacher.builder.dripDaysHint')}
                      </span>
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
              <button
                type="button"
                className={`py-2 text-sm font-bold ${!freePreview ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                onClick={() => setFreePreview(false)}
              >
                {t('teacher.builder.paid')}
              </button>
              <button
                type="button"
                className={`py-2 text-sm font-bold ${freePreview ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                onClick={() => setFreePreview(true)}
              >
                {t('teacher.builder.freePreview')}
              </button>
            </div>
            <p className="text-xs text-outline">{t('teacher.builder.freePreviewHint')}</p>
          </div>

          <div>
            <p className="mb-1 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">quiz</span>
              {t('assess.builder.courseLevel')}
            </p>
            <p className="mb-2 text-xs text-outline">{t('assess.builder.courseLevelHint')}</p>

            {/* Naming this lesson as the course's exam, rather than giving every
                lesson its own. One course, one exam, one assignment. */}
            <div className="space-y-2">
              <label
                className={`flex items-start gap-2 rounded-lg border p-3 text-sm transition ${
                  course?.examLessonId === selected!.id
                    ? 'border-primary bg-primary-fixed/30'
                    : 'border-outline-variant/60'
                } ${selected!.type === 'QUIZ' ? '' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  disabled={selected!.type !== 'QUIZ' || setRole.isPending}
                  checked={course?.examLessonId === selected!.id}
                  // Named as the paper at the end, which is what a teacher
                  // means by "the course's exam". A placement test that shuts
                  // the course is the other choice, made deliberately below.
                  onChange={(e) =>
                    setRole.mutate(
                      e.target.checked
                        ? { examLessonId: selected!.id, examMode: 'FINAL' }
                        : { examLessonId: null },
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{t('assess.builder.isExam')}</span>
                  <span className="mt-0.5 block text-xs text-on-surface-variant">
                    {selected!.type !== 'QUIZ'
                      ? t('assess.builder.onlyQuizLesson')
                      : t('assess.builder.isExamHint')}
                  </span>
                </span>
              </label>

              {/* What the exam is for. Two very different things were one
                  checkbox: naming a lesson as the exam shut the whole course
                  behind it, so a teacher who meant "the test at the end" locked
                  their students out of the course on the way to it. */}
              {course?.examLessonId === selected!.id && (
                <div className="space-y-2 rounded-lg bg-surface-container-low p-3">
                  <p className="text-xs font-bold text-on-surface-variant">
                    {t('assess.builder.examModeTitle')}
                  </p>
                  {(['FINAL', 'GATE'] as const).map((mode) => (
                    <label
                      key={mode}
                      className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm transition ${
                        (course?.examMode ?? 'FINAL') === mode
                          ? 'border-primary bg-primary-fixed/30'
                          : 'border-outline-variant/60'
                      }`}
                    >
                      <input
                        type="radio"
                        className="mt-0.5 accent-primary"
                        name="examMode"
                        disabled={setRole.isPending}
                        checked={(course?.examMode ?? 'FINAL') === mode}
                        onChange={() => setRole.mutate({ examMode: mode })}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold">
                          {t(`assess.builder.examMode.${mode}`)}
                        </span>
                        <span className="mt-0.5 block text-xs text-on-surface-variant">
                          {t(`assess.builder.examMode.${mode}Hint`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <label
                className={`flex items-start gap-2 rounded-lg border p-3 text-sm transition ${
                  course?.assignmentLessonId === selected!.id
                    ? 'border-primary bg-primary-fixed/30'
                    : 'border-outline-variant/60'
                } ${selected!.type === 'ASSIGNMENT' ? '' : 'opacity-50'}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  disabled={selected!.type !== 'ASSIGNMENT' || setRole.isPending}
                  checked={course?.assignmentLessonId === selected!.id}
                  onChange={(e) =>
                    setRole.mutate({ assignmentLessonId: e.target.checked ? selected!.id : null })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-bold">{t('assess.builder.isAssignment')}</span>
                  {selected!.type !== 'ASSIGNMENT' && (
                    <span className="mt-0.5 block text-xs text-on-surface-variant">
                      {t('assess.builder.onlyAssignmentLesson')}
                    </span>
                  )}
                </span>
              </label>
            </div>
            <ErrorNote error={setRole.error} />

            <div className="mt-3 grid grid-cols-2 gap-2">
              {/* `?course=` so the back link there returns to this lesson. */}
              <Link
                to={`/teacher/lessons/${selected!.id}/quiz?course=${id}`}
                className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary"
              >
                <span className="material-symbols-outlined text-base">quiz</span>
                {t('assess.builder.editQuiz')}
              </Link>
              <Link
                to={`/teacher/lessons/${selected!.id}/assignment?course=${id}`}
                className="flex items-center justify-center gap-1 rounded-lg border border-outline-variant/60 bg-surface-container-lowest py-2.5 text-sm font-bold text-on-surface-variant transition hover:border-primary hover:text-primary"
              >
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
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-lg bg-surface-container-low px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="material-symbols-outlined text-base text-error">
                      picture_as_pdf
                    </span>
                    <span className="truncate" dir="auto">
                      {a.fileName}
                    </span>
                  </span>
                  <button
                    className="text-outline hover:text-error"
                    onClick={() => removeAttachment.mutate(a.id)}
                  >
                    <span className="material-symbols-outlined text-base">close</span>
                  </button>
                </li>
              ))}
            </ul>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.zip,.doc,.docx,.txt"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && uploadAttachment(e.target.files[0])}
            />
            {filePct != null ? (
              <UploadPanel
                phase="uploading"
                pct={filePct}
                fileName={fileUp?.name}
                fileSize={fileUp?.size}
                onCancel={() => fileAbort.current?.abort()}
              />
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
              <span className="material-symbols-outlined text-[14px] text-secondary">
                cloud_done
              </span>
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
    <div className="page">
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
          {isPublished && course.canEdit !== false && (
            <button
              className="btn-secondary py-2 text-sm"
              disabled={publish.isPending}
              onClick={() => publish.mutate('PUBLISHED')}
            >
              <span className="material-symbols-outlined text-[20px]">publish</span>
              {t('teacher.builder.republish')}
            </button>
          )}
        </div>
      </div>
      {publish.error && <PublishError error={publish.error} t={t} />}

      {/* Oversight, not authorship. A Center's desk and the platform admin can
          open any course under them and watch every lesson in full, for free —
          that is what the whole page below is for them. What they cannot do is
          change it: the API refuses any write from someone who is not the
          author, so this says so up front rather than letting them find out on
          a save. Unpublishing is still theirs, from the courses list. */}
      {course.canEdit === false && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-outline-variant bg-surface-container-low p-4">
          <span className="material-symbols-outlined text-primary">visibility</span>
          <div>
            <p className="font-bold">{t('teacher.builder.readOnly')}</p>
            <p className="text-sm text-on-surface-variant">{t('teacher.builder.readOnlyHint')}</p>
          </div>
        </div>
      )}

      {/*
        Course cover.
        
        A picture the teacher has chosen is worth showing at size. A picture
        they have not is worth one line — the empty state used to take more
        vertical room than three lessons, and pushed the thing the page is
        actually for below the fold.
      */}
      <input
        ref={thumbInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && thumbUpload.mutate(e.target.files[0])}
      />
      {course.thumbnailUrl ? (
        <div className="mb-5 overflow-hidden rounded-2xl border border-outline-variant/50">
          <div className="relative h-44 bg-surface-container-high sm:h-56">
            <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            <button
              className="absolute end-3 bottom-3 flex items-center gap-1.5 rounded-xl bg-surface-container-lowest/90 px-3 py-2 text-sm font-bold text-primary shadow-card backdrop-blur transition hover:bg-surface-container-lowest"
              disabled={thumbUpload.isPending}
              onClick={() => thumbInput.current?.click()}
            >
              <span className="material-symbols-outlined text-base">
                {thumbUpload.isPending ? 'hourglass' : 'photo_camera'}
              </span>
              {thumbUpload.isPending ? t('common.saving') : t('teacher.builder.changeCover')}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="group mb-5 flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low/40 p-4 text-start transition hover:border-primary hover:bg-primary-fixed/20"
          disabled={thumbUpload.isPending}
          onClick={() => thumbInput.current?.click()}
        >
          <span className="grid h-14 w-20 shrink-0 place-items-center rounded-xl bg-surface-container-high text-outline transition group-hover:bg-primary-fixed group-hover:text-on-primary-fixed">
            <span className="material-symbols-outlined text-[26px]">
              {thumbUpload.isPending ? 'hourglass' : 'add_photo_alternate'}
            </span>
          </span>
          <span className="min-w-0">
            <span className="block font-heading font-bold">
              {thumbUpload.isPending ? t('common.saving') : t('teacher.builder.addCover')}
            </span>
            <span className="mt-0.5 block text-sm text-on-surface-variant">
              {t('teacher.builder.addCoverHint')}
            </span>
          </span>
        </button>
      )}
      <ErrorNote error={thumbUpload.error} />

      {/*
        Course intro clip.

        The teacher's own pitch for the course, and the one piece of it a
        visitor can watch before paying — so it is stored and served as a plain
        public MP4, not through the protected lesson pipeline.
      */}
      <input
        ref={introInput}
        type="file"
        accept="video/mp4"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) uploadIntro(f);
        }}
      />
      {course.introVideoUrl ? (
        <div className="mb-5 overflow-hidden rounded-2xl border border-outline-variant/50">
          <video
            src={apiOrigin() + course.introVideoUrl}
            controls
            playsInline
            className="h-44 w-full bg-black object-contain sm:h-56"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface-container-lowest px-4 py-3">
            <p className="me-auto font-heading font-bold">{t('teacher.builder.introVideo')}</p>
            <button
              className="flex items-center gap-1.5 text-sm font-bold text-primary hover:underline disabled:opacity-50"
              disabled={introPct !== null}
              onClick={() => introInput.current?.click()}
            >
              <span className="material-symbols-outlined text-base">autorenew</span>
              {introPct !== null
                ? t('teacher.builder.uploading', { pct: introPct })
                : t('teacher.builder.replaceIntro')}
            </button>
            <button
              className="flex items-center gap-1.5 text-sm font-bold text-error hover:underline disabled:opacity-50"
              disabled={removeIntro.isPending || introPct !== null}
              onClick={async () =>
                (await askConfirm(t('teacher.builder.removeIntroConfirm'))) && removeIntro.mutate()
              }
            >
              <span className="material-symbols-outlined text-base">delete</span>
              {t('common.delete')}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="group mb-5 flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-outline-variant bg-surface-container-low/40 p-4 text-start transition hover:border-primary hover:bg-primary-fixed/20 disabled:opacity-70"
          disabled={introPct !== null}
          onClick={() => introInput.current?.click()}
        >
          <span className="grid h-14 w-20 shrink-0 place-items-center rounded-xl bg-surface-container-high text-outline transition group-hover:bg-primary-fixed group-hover:text-on-primary-fixed">
            <span className="material-symbols-outlined text-[26px]">
              {introPct !== null ? 'hourglass' : 'movie'}
            </span>
          </span>
          <span className="min-w-0">
            <span className="block font-heading font-bold">
              {introPct !== null
                ? t('teacher.builder.uploading', { pct: introPct })
                : t('teacher.builder.addIntro')}
            </span>
            <span className="mt-0.5 block text-sm text-on-surface-variant">
              {t('teacher.builder.addIntroHint')}
            </span>
          </span>
        </button>
      )}
      {introPct !== null && (
        <div className="-mt-3 mb-5 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
          <div className="h-full bg-primary transition-all" style={{ width: `${introPct}%` }} />
        </div>
      )}
      <ErrorNote error={introError ?? removeIntro.error} />

      {/* Summary strip — what used to be the pricing card in the side column. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-outline-variant/60 bg-surface-container-lowest px-4 py-3">
        <p className="text-sm text-on-surface-variant">
          {t('teacher.builder.countSummary', { lessons: lessons.length, time: duration(totalSec) })}
        </p>
        <p className="flex items-baseline gap-2 text-sm text-on-surface-variant">
          <span>
            {t(
              `teacher.courses.form.${course.pricingModel === 'ONE_TIME' ? 'oneTime' : course.pricingModel === 'MONTHLY_SUBSCRIPTION' ? 'monthly' : 'bundle'}`,
            )}
          </span>
          <span className="font-heading text-xl font-extrabold text-on-surface">
            {egp(course.priceCents)}
            {course.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
              <span className="text-xs font-normal text-outline">/{t('course.perMonth')}</span>
            )}
          </span>
        </p>
      </div>

      {/*
        The curriculum, as one list.
        
        This used to be a card per section holding a bordered box per lesson,
        inside the page's own card — three nested borders to draw a list of
        names, and every section carrying its own dashed add box and import
        link. Nine lessons filled four screens and read as heavy as they were.
        
        One surface now, sections as headings inside it, lessons as rows with a
        hairline between them. The chrome that was repeated per section — the
        add box, the import link — is a single quiet control where it belongs.
      */}
      <div className="card mb-5 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-4 sm:px-5">
          <p className="font-heading text-lg font-bold">{t('teacher.builder.curriculum')}</p>
          <span className="text-sm text-on-surface-variant">
            {missingVideo > 0
              ? t('teacher.builder.lessonsMetaMissing', {
                  count: lessons.length,
                  missing: missingVideo,
                })
              : t('teacher.builder.lessonsMeta', { count: lessons.length })}
          </span>
          <button
            className="ms-auto flex items-center gap-1.5 text-sm font-bold text-primary hover:underline"
            onClick={() => openImport(undefined)}
          >
            <span className="material-symbols-outlined text-base">smart_display</span>
            {t('teacher.builder.importYoutubeBtn')}
          </button>
        </div>

        {/* Lessons with no section of their own sit first, unlabelled — there
            is nothing to call them that is not just "the course". */}
        {defaultUnit?.lessons.length > 0 && (
          <ul className="border-t border-outline-variant/40">
            {defaultUnit.lessons.map((l: any, li: number) => (
              <LessonRow
                key={l.id}
                l={l}
                li={li}
                open={selectedLessonId === l.id}
                onToggle={() =>
                  selectedLessonId === l.id ? setSelectedLessonId(null) : selectLesson(l)
                }
                onDelete={async () =>
                  (await askConfirm(t('teacher.builder.deleteLessonConfirm'))) &&
                  removeLesson.mutate(l.id)
                }
                panel={lessonPanel}
                t={t}
              />
            ))}
          </ul>
        )}
        <div className="border-t border-outline-variant/40 px-4 py-2 sm:px-5">
          <AddLessonRow
            busy={addLessonDirect.isPending}
            placeholder={t('teacher.builder.lessonNamePh')}
            label={t('teacher.builder.addLessonCta')}
            onAdd={(title) => addLessonDirect.mutate(title)}
          />
        </div>

        {sections.map((u: any, ui: number) => {
          const gap = u.lessons.filter((x: any) => !x.videoAsset && x.type === 'VIDEO').length;
          const shut = folded.has(u.id);
          return (
            <div key={u.id} className="border-t-4 border-outline-variant/25">
              <div className="group/unit flex min-h-[3.5rem] items-center gap-2 bg-surface-container-high/60 px-2 py-2 sm:px-3">
                <button
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high"
                  aria-expanded={!shut}
                  title={t(shut ? 'teacher.builder.unfold' : 'teacher.builder.fold')}
                  onClick={() => toggleFold(u.id)}
                >
                  <span
                    className={`material-symbols-outlined text-[20px] transition-transform ${shut ? '-rotate-90' : ''}`}
                  >
                    expand_more
                  </span>
                </button>
                <Badge>{t('teacher.builder.unitBadge', { n: ui + 1 })}</Badge>
                <InlineName
                  value={u.title}
                  editing={renaming === `unit:${u.id}`}
                  onEdit={() => setRenaming(`unit:${u.id}`)}
                  onDone={(title) => {
                    setRenaming(null);
                    if (title && title !== u.title) renameUnit.mutate({ unitId: u.id, title });
                  }}
                  className="min-w-0 flex-1 font-heading text-lg font-bold"
                />
                {/* The name is what a teacher navigates by, so it keeps the
                    width. The count is detail, and on a phone it was crowding
                    "الفصل الأول: الطفولة" down to "الفصل…" — while the same
                    figure for the whole course sits at the top of this list. */}
                <span className="ms-auto hidden shrink-0 text-sm text-on-surface-variant sm:inline">
                  {gap
                    ? t('teacher.builder.lessonsMetaMissing', {
                        count: u.lessons.length,
                        missing: gap,
                      })
                    : t('teacher.builder.lessonsMeta', { count: u.lessons.length })}
                </span>
                {/* Arms on the first press instead of stopping the page with a
                    dialog nobody reads — see DeleteButton. */}
                <DeleteButton
                  compact
                  className="shrink-0 border-0 sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/unit:opacity-100"
                  onConfirm={() => removeUnit.mutateAsync(u.id)}
                />
              </div>

              {!shut && (
                <>
                  <ul>
                    {u.lessons.map((l: any, li: number) => (
                      <LessonRow
                        key={l.id}
                        l={l}
                        li={li}
                        open={selectedLessonId === l.id}
                        onToggle={() =>
                          selectedLessonId === l.id ? setSelectedLessonId(null) : selectLesson(l)
                        }
                        onDelete={async () =>
                          (await askConfirm(t('teacher.builder.deleteLessonConfirm'))) &&
                          removeLesson.mutate(l.id)
                        }
                        panel={lessonPanel}
                        t={t}
                      />
                    ))}
                  </ul>
                  <div className="border-t border-outline-variant/40 px-4 py-2 sm:px-5">
                    <AddLessonRow
                      busy={addLesson.isPending}
                      placeholder={t('teacher.builder.lessonNamePh')}
                      label={t('teacher.builder.addLessonCta')}
                      onAdd={(title) => addLesson.mutate({ unitId: u.id, title })}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}

        <button
          className="flex w-full items-center justify-center gap-1.5 border-t border-outline-variant/40 py-4 font-bold text-on-surface-variant transition hover:bg-surface-container-low hover:text-primary"
          disabled={addUnit.isPending}
          onClick={() =>
            addSection(() =>
              addUnit.mutate(t('teacher.builder.newUnitName', { n: sections.length + 1 })),
            )
          }
        >
          <span className="material-symbols-outlined text-[20px]">add</span>
          {t('teacher.builder.addUnit')}
        </button>
      </div>

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
          <button
            className="btn-secondary"
            disabled={publish.isPending}
            onClick={() => publish.mutate('DRAFT')}
          >
            <span className="material-symbols-outlined text-[20px]">visibility_off</span>
            {t('teacher.builder.unpublish')}
          </button>
        ) : (
          <button
            className="btn-primary px-7 py-3"
            disabled={publish.isPending}
            onClick={() => publish.mutate('PUBLISHED')}
          >
            <span className="material-symbols-outlined text-[20px]">publish</span>
            {t('teacher.builder.publishNow')}
          </button>
        )}
      </div>
      {publish.error && <PublishError error={publish.error} t={t} />}

      <Modal
        open={importOpen}
        title={t('teacher.builder.importYoutubeTitle')}
        onClose={() => setImportOpen(false)}
        wide
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-bold">
              {t('teacher.builder.importYoutubeLabel')}
            </label>
            <div className="space-y-2">
              {importUrls.map((url, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-sm font-bold text-on-surface-variant">
                    {t('teacher.builder.importVideoN', { n: i + 1 })}
                  </span>
                  <input
                    className="input"
                    dir="ltr"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={url}
                    onChange={(e) => setImportUrlAt(i, e.target.value)}
                  />
                  <button
                    type="button"
                    title={t('common.delete')}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-outline transition hover:bg-error-container hover:text-on-error-container disabled:pointer-events-none disabled:opacity-30"
                    disabled={importUrls.length <= 1}
                    onClick={() => removeImportUrl(i)}
                  >
                    <span className="material-symbols-outlined text-lg">close</span>
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 flex items-center gap-1.5 text-sm font-bold text-primary hover:underline"
              onClick={addImportUrl}
            >
              <span className="material-symbols-outlined text-base">add</span>
              {t('teacher.builder.importAddLink')}
            </button>
            <p className="mt-2 text-xs text-outline">{t('teacher.builder.importYoutubeHint')}</p>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">visibility</span>
              {t('teacher.builder.accessType')}
            </p>
            <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-outline-variant/60">
              <button
                type="button"
                className={`py-2 text-sm font-bold ${!importFreePreview ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                onClick={() => setImportFreePreview(false)}
              >
                {t('teacher.builder.paid')}
              </button>
              <button
                type="button"
                className={`py-2 text-sm font-bold ${importFreePreview ? 'bg-primary-fixed text-on-primary-fixed' : 'bg-surface-container-lowest text-on-surface-variant'}`}
                onClick={() => setImportFreePreview(true)}
              >
                {t('teacher.builder.freePreview')}
              </button>
            </div>
          </div>

          <div>
            <p className="mb-2 flex items-center gap-1 text-sm font-bold">
              <span className="material-symbols-outlined text-base">lock_clock</span>
              {t('teacher.builder.drip')}
            </p>
            <div className="space-y-2">
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${importDrip === 'now' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={importDrip === 'now'}
                  onChange={() => setImportDrip('now')}
                />
                <span>
                  <span className="block text-sm font-bold">
                    {t('teacher.builder.dripImmediate')}
                  </span>
                  <span className="text-xs text-outline">
                    {t('teacher.builder.dripImmediateHint')}
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${importDrip === 'date' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={importDrip === 'date'}
                  onChange={() => setImportDrip('date')}
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{t('teacher.builder.dripDate')}</span>
                  {importDrip === 'date' && (
                    <input
                      type="date"
                      className="input mt-2 py-1.5 text-sm"
                      value={importDripDate}
                      onChange={(e) => setImportDripDate(e.target.value)}
                    />
                  )}
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${importDrip === 'days' ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/50'}`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  checked={importDrip === 'days'}
                  onChange={() => setImportDrip('days')}
                />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{t('teacher.builder.dripDays')}</span>
                  {importDrip === 'days' && (
                    <span className="mt-2 flex items-center gap-2">
                      <input
                        className="input w-20 py-1.5 text-sm"
                        inputMode="numeric"
                        value={importDripDays}
                        onChange={(e) => setImportDripDays(e.target.value.replace(/\D/g, ''))}
                      />
                      <span className="text-xs text-outline">
                        {t('teacher.builder.dripDaysHint')}
                      </span>
                    </span>
                  )}
                </span>
              </label>
            </div>
          </div>

          {importYoutube.data?.results && (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-outline-variant/40 p-3 text-sm">
              {importYoutube.data.results.map((r, i) => (
                <li key={i} className={r.error ? 'text-error' : 'text-secondary'}>
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined shrink-0 text-base">
                      {r.error ? 'error' : 'check_circle'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.error ? t(`teacher.builder.importError.${r.error}`) : r.lesson?.title}
                    </span>
                  </span>
                  {r.detail && (
                    <span className="ms-6 block truncate text-xs text-outline" dir="ltr">
                      {r.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {importYoutube.error && <ErrorNote error={importYoutube.error} />}

          <button
            className="btn-primary w-full py-3"
            disabled={importYoutube.isPending || !importUrls.some((u) => u.trim())}
            onClick={() => importYoutube.mutate()}
          >
            {importYoutube.isPending
              ? t('teacher.builder.importing')
              : t('teacher.builder.importNow')}
          </button>
        </div>
      </Modal>
    </div>
  );
}

/** A publish failure the teacher can actually read — "no lessons yet" gets
 *  its own line; anything else falls back to whatever the server said. */
function PublishError({ error, t }: { error: unknown; t: (k: string) => string }) {
  const data = (error as any)?.response?.data;
  const text =
    data?.code === 'NO_LESSONS' ? t('teacher.builder.noLessonsToPublish') : data?.message;
  return (
    <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
      {text || t('common.error')}
    </p>
  );
}

/** Replace / delete, shared by every state a video can be in. */
function VideoActions({
  onReplace,
  onDelete,
  busy,
  t,
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
  l,
  li,
  open,
  onToggle,
  onDelete,
  panel,
  t,
}: {
  l: any;
  li: number;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  panel: ReactNode;
  t: (k: string, o?: any) => string;
}) {
  const processing = l.videoAsset && ['UPLOADING', 'PROCESSING'].includes(l.videoAsset.status);
  const needsVideo = l.type === 'VIDEO' && !l.videoAsset;
  return (
    <li className="border-t border-outline-variant/40 first:border-t-0">
      <div
        className={`group/lesson flex min-h-[3.5rem] cursor-pointer items-center gap-3 px-4 py-2 transition sm:px-5 ${
          open ? 'bg-primary-fixed/40' : 'hover:bg-surface-container-low'
        }`}
        onClick={onToggle}
      >
        {/* The icon carries the state, so the row does not need a second line
            to say "no video yet" — the thing a teacher scans for. */}
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
            needsVideo
              ? 'bg-surface-container-high text-on-surface-variant'
              : 'bg-secondary-container text-on-secondary-container'
          }`}
          title={needsVideo ? t('teacher.builder.needsVideo') : undefined}
        >
          <span className="material-symbols-outlined text-[20px]">
            {l.type === 'QUIZ'
              ? 'quiz'
              : l.type === 'ASSIGNMENT'
                ? 'assignment'
                : l.videoAsset
                  ? 'play_circle'
                  : 'videocam_off'}
          </span>
        </span>
        <span className="w-5 shrink-0 text-sm tabular-nums text-on-surface-variant">{li + 1}</span>
        <span className="min-w-0 flex-1 truncate font-semibold" title={l.title}>
          {l.title}
        </span>

        {/* Everything after the name is optional detail, and drops off first
            when the row runs out of width. */}
        {processing && (
          <span className="shrink-0 text-sm font-semibold text-primary">
            {t('teacher.builder.videoProcessing')}
          </span>
        )}
        {l.isFreePreview && (
          <span className="hidden shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs font-bold text-on-secondary-container sm:inline">
            {t('teacher.builder.freePreview')}
          </span>
        )}
        {(l.dripUnlockAt || l.dripAfterEnrollDays != null) && (
          <span
            className="material-symbols-outlined hidden shrink-0 text-[18px] text-on-surface-variant sm:inline"
            title="Drip"
          >
            lock_clock
          </span>
        )}
        {l.durationSec > 0 && (
          <span className="hidden shrink-0 text-sm tabular-nums text-on-surface-variant sm:inline">
            {duration(l.durationSec)}
          </span>
        )}

        <button
          title={t('common.delete')}
          aria-label={t('common.delete')}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-outline transition hover:bg-error-container hover:text-on-error-container sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover/lesson:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <span className="material-symbols-outlined text-[18px]">delete</span>
        </button>
        <span
          className={`material-symbols-outlined shrink-0 text-[20px] text-outline transition ${open ? 'rotate-180' : ''}`}
        >
          expand_more
        </span>
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
/**
 * Let an action fire once, even when the page is too busy to re-render.
 *
 * `isPending` is state, and state arrives a render late. While a video uploads
 * the main thread has other work, so the clicks and keystrokes queued in the
 * meantime all run before React has had a chance to disable anything — and the
 * teacher gets two sections, or three lessons, all named the same. A ref closes
 * in the same tick as the event, which is the only thing fast enough.
 */
function useOnce(busy: boolean) {
  const sending = useRef(false);
  useEffect(() => {
    if (!busy) sending.current = false;
  }, [busy]);
  return (run: () => void) => {
    if (busy || sending.current) return;
    sending.current = true;
    run();
  };
}

function AddLessonRow({
  onAdd,
  busy,
  placeholder,
  label,
}: {
  onAdd: (title: string) => void;
  busy: boolean;
  placeholder: string;
  label: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const once = useOnce(busy);

  const submit = () => {
    const title = value.trim();
    if (!title) return;
    once(() => {
      onAdd(title);
      setValue('');
      ref.current?.focus();
    });
  };

  // A quiet line, not a dashed box. Repeated once per section, the box was
  // more visual weight than the lessons it sat under — and it advertised an
  // action the teacher already knows is there.
  return (
    <div className="flex min-h-[3rem] items-center gap-3 transition">
      <span className="material-symbols-outlined text-[22px] text-on-surface-variant">add</span>
      <input
        ref={ref}
        className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-2.5 outline-none transition placeholder:text-on-surface-variant/70 focus:bg-surface-container-low"
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
      {/* Only once there is something to add: an always-visible button here is
          a permanent call to action on a row that is already an invitation. */}
      {value.trim() && (
        <button
          className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-bold text-on-primary-fixed transition hover:bg-primary-fixed disabled:opacity-40"
          disabled={busy}
          onClick={submit}
        >
          {label}
        </button>
      )}
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
  value,
  editing,
  onEdit,
  onDone,
  className = '',
  clickToEdit = true,
}: {
  value: string;
  editing: boolean;
  onEdit: () => void;
  onDone: (title: string) => void;
  className?: string;
  /**
   * Whether clicking the name starts a rename.
   *
   * True for a section heading, which does nothing else. False inside a lesson
   * row, where the whole row opens the lesson: there the name is the biggest
   * thing to aim at, so a teacher reaching for the settings kept landing in a
   * text field instead. Renaming there is its own button.
   */
  clickToEdit?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, editing]);

  if (!editing) {
    if (!clickToEdit) {
      return (
        <span className={`min-w-0 truncate ${className}`} title={value}>
          {value}
        </span>
      );
    }
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

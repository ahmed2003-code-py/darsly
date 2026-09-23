import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

/**
 * Work in progress, saved without anybody pressing save.
 *
 * The rule this exists to enforce: nothing a teacher typed is ever lost
 * because they went somewhere else. Everything below is either an HTTP call or
 * a pure function, so the decisions — is this worth saving, has it changed,
 * what does the banner say — can be tested without rendering a form.
 */

export type DraftKind = 'LESSON' | 'ASSIGNMENT' | 'QUIZ' | 'COURSE' | 'EXAM_STUDIO';

export interface DraftSummary {
  id: string;
  kind: DraftKind;
  label: string;
  step: string;
  courseId: string | null;
  lessonId: string | null;
  updatedAt: string;
  /** Studio sessions only. */
  status?: string;
  stage?: string;
  progress?: { done: number; total: number };
}

export interface StoredDraft<T> extends DraftSummary {
  data: T;
}

/** The key a form knows its own draft by. One string, built in one place, so
 *  the form that saves and the banner that lists cannot disagree about it. */
export const draftKey = {
  lesson: (lessonId: string) => `lesson:${lessonId}`,
  newLesson: (courseId: string) => `lesson:new:${courseId}`,
  assignment: (lessonId: string) => `assignment:${lessonId}`,
  quiz: (lessonId: string) => `quiz:${lessonId}`,
  course: (courseId: string) => `course:${courseId}`,
};

export async function listDrafts(courseId?: string): Promise<DraftSummary[]> {
  const { data } = await api.get('/teacher/drafts', {
    params: courseId ? { courseId } : undefined,
  });
  return data;
}

export async function fetchDraft<T>(scopeKey: string): Promise<StoredDraft<T> | null> {
  const { data } = await api.get(`/teacher/drafts/${encodeURIComponent(scopeKey)}`);
  return data ?? null;
}

export async function putDraft(body: {
  kind: Exclude<DraftKind, 'EXAM_STUDIO'>;
  scopeKey: string;
  courseId?: string;
  lessonId?: string;
  label?: string;
  step?: string;
  data: unknown;
}): Promise<DraftSummary> {
  const { data } = await api.put('/teacher/drafts', body);
  return data;
}

export async function discardDraft(scopeKey: string): Promise<void> {
  await api.delete(`/teacher/drafts/${encodeURIComponent(scopeKey)}`);
}

/** Put one Exam Studio session down (and stop it, if it is still reading). */
export async function dropStudioSession(id: string): Promise<void> {
  await api.delete(`/teacher/drafts/sessions/${encodeURIComponent(id)}`);
}

/** Everything on the list — the caller's own only; the server enforces that. */
export async function clearDrafts(opts: {
  courseId?: string;
  kind?: 'EXAM_STUDIO';
}): Promise<{ removed: number }> {
  const { data } = await api.delete('/teacher/drafts', { params: opts });
  return data;
}

/**
 * Where a draft is picked up again.
 *
 * Built here rather than on the server: these are the web app's own routes,
 * checked by `scripts/check-web-routes.mjs`, and a second copy of them in an
 * API response is a copy nothing would notice going stale.
 */
export function resumeHref(draft: DraftSummary): string {
  switch (draft.kind) {
    case 'EXAM_STUDIO':
      return draft.courseId
        ? `/teacher/exam-studio/${draft.id}?course=${draft.courseId}`
        : `/teacher/exam-studio/${draft.id}`;
    case 'ASSIGNMENT':
      return draft.lessonId ? `/teacher/lessons/${draft.lessonId}/assignment` : '/teacher/courses';
    case 'QUIZ':
      return draft.lessonId ? `/teacher/lessons/${draft.lessonId}/quiz` : '/teacher/courses';
    case 'LESSON':
    case 'COURSE':
    default:
      return draft.courseId ? `/teacher/courses/${draft.courseId}` : '/teacher/courses';
  }
}

/**
 * Is this draft still worth offering?
 *
 * A form that has been opened and not typed in produces an empty draft, and
 * offering to restore nothing is worse than offering nothing: it trains a
 * teacher to dismiss the banner without reading it.
 */
export function isWorthKeeping(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return Object.values(data as Record<string, unknown>).some((v) => {
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return true;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') return isWorthKeeping(v);
    return false;
  });
}

/** How long ago, in the words a person uses. Exported for the banner and for
 *  its test; `Intl.RelativeTimeFormat` does the language, not a table here. */
export function agoLabel(iso: string, locale: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(Math.min(-1, seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

/** How long typing stops before a save is worth making. Long enough that a
 *  sentence is one save rather than forty, short enough that a teacher who
 *  closes the tab mid-thought loses at most a couple of seconds of it. */
const QUIET_MS = 1500;

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Save a form as it is typed in.
 *
 * Three things save it: a pause in typing, the tab being hidden, and the
 * component going away. The last two matter more than the first — leaving is
 * exactly the moment the work was being lost, and `visibilitychange` is the
 * only event a browser reliably gives you when a tab is closed on a phone.
 *
 * `enabled` is how a form says "there is nothing here yet". Passing an empty
 * form's state would write a draft for every lesson anybody ever opened.
 */
export function useAutosaveDraft<T>(opts: {
  kind: Exclude<DraftKind, 'EXAM_STUDIO'>;
  scopeKey: string | null;
  courseId?: string;
  lessonId?: string;
  label?: string;
  step?: string;
  data: T;
  enabled?: boolean;
}): { state: AutosaveState; savedAt: string | null; saveNow: () => void; clear: () => void } {
  const [state, setState] = useState<AutosaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const serialised = useMemo(() => JSON.stringify(opts.data ?? null), [opts.data]);
  const latest = useRef({ serialised, opts });
  latest.current = { serialised, opts };
  /** What is already on the server. Saving the same bytes again is a write
   *  nobody asked for and a "saved" flash that means nothing. */
  const written = useRef<string | null>(null);

  const flush = useRef(async () => {
    const { serialised: body, opts: current } = latest.current;
    if (!current.scopeKey || current.enabled === false) return;
    if (body === written.current) return;
    if (!isWorthKeeping(current.data)) return;
    setState('saving');
    try {
      const saved = await putDraft({
        kind: current.kind,
        scopeKey: current.scopeKey,
        courseId: current.courseId,
        lessonId: current.lessonId,
        label: current.label,
        step: current.step,
        data: current.data,
      });
      written.current = body;
      setSavedAt(saved.updatedAt);
      setState('saved');
    } catch {
      // Deliberately quiet. A failed autosave is not something to interrupt
      // someone's writing with — the indicator says it, and the next pause
      // tries again.
      setState('error');
    }
  });

  useEffect(() => {
    if (!opts.scopeKey || opts.enabled === false) return;
    const timer = setTimeout(() => void flush.current(), QUIET_MS);
    return () => clearTimeout(timer);
  }, [serialised, opts.scopeKey, opts.enabled]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush.current();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      void flush.current();
    };
  }, []);

  return {
    state,
    savedAt,
    saveNow: () => void flush.current(),
    /** Called when the form saves for real: the draft is now a stale copy of
     *  something that exists, and leaving it would offer to restore an older
     *  version of the lesson the teacher just saved. */
    clear: () => {
      const key = latest.current.opts.scopeKey;
      written.current = null;
      setState('idle');
      setSavedAt(null);
      if (key) void discardDraft(key).catch(() => undefined);
    },
  };
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  DraftKind,
  DraftSummary,
  agoLabel,
  clearDrafts,
  discardDraft,
  dropStudioSession,
  listDrafts,
  resumeHref,
} from '../lib/drafts';
import { askConfirm } from '../lib/confirm';
import { toastError, toastSuccess } from '../lib/toast';

/**
 * "You were in the middle of something."
 *
 * Shown where a teacher goes to carry on — the top of My courses, the top of
 * a course, the Exam Studio's start screen. Before this there was no door
 * back to unfinished work at all; the only way in was a URL nobody had kept.
 *
 * It is a list a teacher manages, not only one they read: every row can be
 * thrown away, and so can the lot. Twelve rows of "exam without a name" with
 * no way to thin them is a wall, and a wall gets ignored.
 *
 * It renders nothing when there is nothing unfinished — the normal case, and
 * it has to stay silent.
 */

/** Rows shown before "show all". Enough to see the newest, few enough that
 *  the list does not push the page it sits on off the screen. */
const PREVIEW = 3;

export function DraftsBar({
  courseId,
  only,
  title,
}: {
  courseId?: string;
  /** Narrow to one kind — the Exam Studio's start screen lists only its own
   *  sessions, where a half-written lesson would be beside the point. */
  only?: DraftKind;
  /** A heading that fits where the bar sits, when "unfinished work" does not. */
  title?: string;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data: all = [] } = useQuery({
    queryKey: ['drafts', courseId ?? 'all'],
    queryFn: () => listDrafts(courseId),
    // A studio session's progress moves while this list is on screen, so it is
    // refreshed — slowly. This is a banner, not the progress screen.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d: DraftSummary) => d.status === 'PROCESSING') ? 10000 : false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['drafts'] });

  const drop = useMutation({
    mutationFn: (draft: DraftSummary) =>
      draft.kind === 'EXAM_STUDIO' ? dropStudioSession(draft.id) : discardDraft(keyOf(draft)),
    onSuccess: () => {
      toastSuccess(t('drafts.removedOne'));
      return refresh();
    },
    onError: (e) => toastError(e),
  });

  const clear = useMutation({
    mutationFn: () => clearDrafts({ courseId, ...(only === 'EXAM_STUDIO' ? { kind: only } : {}) }),
    onSuccess: ({ removed }) => {
      toastSuccess(t('drafts.removedAll', { count: removed }));
      setExpanded(false);
      return refresh();
    },
    onError: (e) => toastError(e),
  });

  const drafts = only ? all.filter((d) => d.kind === only) : all;
  if (!drafts.length) return null;

  const shown = expanded ? drafts : drafts.slice(0, PREVIEW);
  const hidden = drafts.length - shown.length;

  const confirmOne = async (draft: DraftSummary) => {
    const running = draft.kind === 'EXAM_STUDIO' && draft.status === 'PROCESSING';
    const ok = await askConfirm(
      t(running ? 'drafts.removeRunningBody' : 'drafts.removeBody', {
        name: nameOf(draft, t),
      }),
      {
        title: t('drafts.removeTitle'),
        confirmLabel: t('drafts.removeConfirm'),
        danger: true,
      },
    );
    if (ok) drop.mutate(draft);
  };

  const confirmAll = async () => {
    const ok = await askConfirm(t('drafts.clearAllBody', { count: drafts.length }), {
      title: t('drafts.clearAllTitle'),
      confirmLabel: t('drafts.clearAllConfirm'),
      danger: true,
    });
    if (ok) clear.mutate();
  };

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest">
      <header className="flex flex-wrap items-center gap-3 border-b border-outline-variant/60 px-4 py-3 sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]">history</span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-heading text-base font-bold text-on-surface">
            {title ?? t('drafts.title')}
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs font-semibold text-on-surface-variant">
              {drafts.length}
            </span>
          </h2>
          <p className="truncate text-xs text-on-surface-variant">{t('drafts.hint')}</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-error transition hover:bg-error/10 disabled:opacity-50"
          disabled={clear.isPending}
          onClick={confirmAll}
        >
          <span className="material-symbols-outlined text-[18px]">delete_sweep</span>
          {t('drafts.clearAll')}
        </button>
      </header>

      <ul className="divide-y divide-outline-variant/50">
        {shown.map((draft) => (
          <li
            key={`${draft.kind}:${draft.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-container-low sm:px-5"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-container-high text-on-surface-variant">
              <span className="material-symbols-outlined text-[20px]">{iconFor(draft)}</span>
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-on-surface">{nameOf(draft, t)}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant">
                <StatusChip draft={draft} />
                <span className="text-outline">{agoLabel(draft.updatedAt, i18n.language)}</span>
                {draft.kind === 'EXAM_STUDIO' && !!draft.progress?.total && (
                  <span className="text-outline">
                    · {t('drafts.pages', { count: draft.progress.total })}
                  </span>
                )}
              </p>
            </div>

            <Link
              className="btn-secondary shrink-0 whitespace-nowrap px-3 py-1.5 text-sm"
              to={resumeHref(draft)}
            >
              {t('drafts.resume')}
            </Link>
            <button
              type="button"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-outline transition hover:bg-error/10 hover:text-error disabled:opacity-50"
              disabled={drop.isPending}
              onClick={() => confirmOne(draft)}
              aria-label={t('drafts.remove')}
              title={t('drafts.remove')}
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </li>
        ))}
      </ul>

      {drafts.length > PREVIEW && (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 border-t border-outline-variant/60 py-2.5 text-sm font-semibold text-primary transition hover:bg-surface-container-low"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('drafts.showLess') : t('drafts.showAll', { count: hidden })}
          <span className="material-symbols-outlined text-[18px]">
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
        </button>
      )}
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** Where the work stands, as a coloured label — the one thing a teacher
 *  scanning twelve rows needs to pick out: which ones are waiting for them. */
function StatusChip({ draft }: { draft: DraftSummary }) {
  const { t } = useTranslation();
  if (draft.kind !== 'EXAM_STUDIO') {
    return (
      <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-semibold text-on-surface-variant">
        {t(`drafts.kind.${draft.kind}`)}
      </span>
    );
  }
  const status = draft.status ?? 'PROCESSING';
  const tone =
    status === 'REVIEW'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : status === 'FAILED'
        ? 'bg-error/10 text-error'
        : status === 'CONFIGURING'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-primary/10 text-primary';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${tone}`}
    >
      {status === 'PROCESSING' && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status === 'PROCESSING' && draft.progress?.total
        ? t('drafts.studioWorking', { done: draft.progress.done, total: draft.progress.total })
        : t(`drafts.studioStatus.${status}`)}
    </span>
  );
}

/** A name a person can tell apart from the next row. An untitled studio
 *  session says what kind of exam it is, instead of "exam without a name"
 *  twelve times over. */
function nameOf(draft: DraftSummary, t: Translate): string {
  if (draft.label?.trim()) return draft.label.trim();
  if (draft.kind === 'EXAM_STUDIO') {
    return t(draft.step === 'CONTENT' ? 'drafts.studioName.CONTENT' : 'drafts.studioName.PAPER');
  }
  return t(`drafts.untitled.${draft.kind}`);
}

/** The scope key a ContentDraft row was saved under, rebuilt from what the
 *  list returns. */
function keyOf(draft: DraftSummary): string {
  switch (draft.kind) {
    case 'ASSIGNMENT':
      return `assignment:${draft.lessonId}`;
    case 'QUIZ':
      return `quiz:${draft.lessonId}`;
    case 'COURSE':
      return `course:${draft.courseId}`;
    case 'LESSON':
    default:
      return draft.lessonId ? `lesson:${draft.lessonId}` : `lesson:new:${draft.courseId}`;
  }
}

function iconFor(draft: DraftSummary): string {
  switch (draft.kind) {
    case 'EXAM_STUDIO':
      return draft.step === 'CONTENT' ? 'auto_awesome' : 'document_scanner';
    case 'ASSIGNMENT':
      return 'assignment';
    case 'QUIZ':
      return 'fact_check';
    case 'COURSE':
      return 'school';
    case 'LESSON':
    default:
      return 'play_lesson';
  }
}

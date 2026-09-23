import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { DraftSummary, agoLabel, discardDraft, listDrafts, resumeHref } from '../lib/drafts';
import { askConfirm } from '../lib/confirm';
import { toastError } from '../lib/toast';

/**
 * "You were in the middle of something."
 *
 * Put at the very top of a course, because that is where a teacher goes to
 * carry on and it is the only place they can be relied upon to look. Before
 * this, unfinished work existed — an Exam Studio session reading pages, a
 * half-written lesson — and there was no door back to it: the only way in was
 * a URL nobody had kept.
 *
 * It renders nothing at all when there is nothing unfinished, which is the
 * normal case and has to stay silent.
 */
export function DraftsBar({ courseId }: { courseId?: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();

  const { data: drafts = [] } = useQuery({
    queryKey: ['drafts', courseId ?? 'all'],
    queryFn: () => listDrafts(courseId),
    // A studio session's progress moves while this list is on screen, so it is
    // refreshed — slowly. This is a banner, not the progress screen.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((d: DraftSummary) => d.status === 'PROCESSING') ? 10000 : false,
  });

  const drop = useMutation({
    mutationFn: (key: string) => discardDraft(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drafts'] }),
    onError: (e) => toastError(e),
  });

  if (!drafts.length) return null;

  return (
    <section className="mb-4 rounded-2xl border border-primary/30 bg-primary/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">history_edu</span>
        <h2 className="font-heading text-base font-semibold text-on-surface">
          {t('drafts.title')}
        </h2>
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
          {drafts.length}
        </span>
      </div>
      <p className="mb-3 text-sm text-on-surface-variant">{t('drafts.hint')}</p>

      <ul className="space-y-2">
        {drafts.map((draft) => (
          <li
            key={`${draft.kind}:${draft.id}`}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-3"
          >
            <span className="material-symbols-outlined text-on-surface-variant">
              {iconFor(draft)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-on-surface">
                {draft.label || t(`drafts.untitled.${draft.kind}`)}
              </p>
              <p className="text-xs text-on-surface-variant">
                {statusLine(draft, t)} · {agoLabel(draft.updatedAt, i18n.language)}
              </p>
            </div>
            <Link className="btn-primary px-4 py-1.5 text-sm" to={resumeHref(draft)}>
              {t('drafts.resume')}
            </Link>
            {draft.kind !== 'EXAM_STUDIO' && (
              <button
                className="btn-ghost px-2 text-sm"
                disabled={drop.isPending}
                onClick={async () => {
                  const ok = await askConfirm(t('drafts.discardBody'), {
                    title: t('drafts.discardTitle'),
                    confirmLabel: t('drafts.discardConfirm'),
                    danger: true,
                  });
                  if (ok) drop.mutate(keyOf(draft));
                }}
              >
                {t('drafts.discard')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The scope key a ContentDraft row was saved under, rebuilt from what the
 *  list returns. Studio sessions are not deletable from here — they are real
 *  sessions with uploaded pages, and throwing one away is done in the studio
 *  where the teacher can see what they would be throwing away. */
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
      return 'quiz';
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

type Translate = ReturnType<typeof useTranslation>['t'];

/** What this draft is doing, in a sentence. A studio session that is still
 *  reading says so with its own numbers; a form says which step it reached. */
function statusLine(draft: DraftSummary, t: Translate): string {
  if (draft.kind === 'EXAM_STUDIO') {
    if (draft.status === 'PROCESSING' && draft.progress?.total) {
      return t('drafts.studioWorking', {
        done: draft.progress.done,
        total: draft.progress.total,
      });
    }
    return t(`drafts.studioStatus.${draft.status ?? 'PROCESSING'}`);
  }
  return t(`drafts.kind.${draft.kind}`);
}

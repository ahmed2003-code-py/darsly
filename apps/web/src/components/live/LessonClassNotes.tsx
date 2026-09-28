import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { isStudyNotes, LegacySummaryView, StudyNotesView, TranscriptViewer, type Segment, type Summary } from './ClassNotes';

/**
 * A course lesson made from a Live class: a subtle «مسجلة من حصة مباشرة», and
 * — if the teacher published them with it — the class's study notes and its
 * transcript, as they were when the lesson was made. Opened by the lesson's
 * own course access (the server decides); renders nothing for any other lesson.
 */
export default function LessonClassNotes({ lessonId }: { lessonId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'notes' | 'transcript' | null>('notes');
  const q = useQuery({
    queryKey: ['lesson-class-notes', lessonId],
    queryFn: async () =>
      (await api.get(`/playback/lessons/${lessonId}/class-notes`)).data as {
        fromLive: boolean;
        summary: Summary | null;
        transcript: Segment[] | null;
        transcriptPartial: boolean;
      },
    retry: false,
    staleTime: 5 * 60_000,
  });
  const d = q.data;
  if (!d?.fromLive) return null;
  const tabs = [
    ...(d.summary ? [{ id: 'notes' as const, label: t('liveContent.studyNotes') }] : []),
    ...(d.transcript?.length ? [{ id: 'transcript' as const, label: t('liveContent.transcript') }] : []),
  ];
  const shown = tabs.some((x) => x.id === open) ? open : (tabs[0]?.id ?? null);
  return (
    <div className="mt-3 space-y-3">
      <p className="inline-flex items-center gap-1 rounded-full bg-surface-container px-2.5 py-0.5 text-xs text-on-surface-variant">
        <span aria-hidden className="material-symbols-outlined text-[14px]">sensors</span>
        {t('liveContent.fromLive')}
      </p>
      {tabs.length > 0 && (
        <div className="rounded-2xl border border-outline-variant/60 p-4">
          <div className="mb-3 flex gap-2" role="tablist">
            {tabs.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={shown === x.id}
                className={`rounded-full px-3 py-1 text-sm font-semibold ${
                  shown === x.id ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'
                }`}
                onClick={() => setOpen(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
          {shown === 'notes' && d.summary && (isStudyNotes(d.summary) ? <StudyNotesView n={d.summary} /> : <LegacySummaryView data={d.summary} />)}
          {shown === 'transcript' && d.transcript && <TranscriptViewer segments={d.transcript} partial={d.transcriptPartial} />}
        </div>
      )}
    </div>
  );
}

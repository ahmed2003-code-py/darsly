import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  groupBySpeaker,
  hasSpeakers,
  speakerLabel,
  type ShownSpeaker,
} from '../../lib/transcriptSpeakers';

/**
 * A class's written record, as students and teachers read it: the grounded
 * study notes (or an older summary) and the searchable transcript. Shared by
 * the Live archive and a course lesson made from a Live class, so both read
 * the same way.
 */

/** A summary written before study notes (schema version 1). */
export interface LegacySummary {
  summary: string;
  topics: string[];
  keyPoints: string[];
  questionsAndAnswers: { question: string; answer: string }[];
  actionItems: string[];
}

/** Study notes (schema version 2) — every item grounded in the transcript on the server. */
export interface StudyNotes {
  schemaVersion: 2;
  title: string;
  quickSummary: string;
  keyPoints: { text: string }[];
  concepts: { term: string; explanation: string }[];
  examples: { text: string }[];
  formulas: { formula: string; meaning: string }[];
  questions: { question: string; answered: boolean; answer: string | null }[];
  homework: { task: string; due: string | null }[];
  corrections: { wrong: string; corrected: string }[];
  reviewPoints: string[];
  studyNotes: string;
}

export type Summary = LegacySummary | StudyNotes;

export const isStudyNotes = (x: Summary): x is StudyNotes => (x as StudyNotes).schemaVersion === 2;

export type Segment = {
  startSec: number | null;
  durationSec: number | null;
  text: string;
  /** Whose microphone (per-speaker capture only; never on older transcripts). */
  speaker?: ShownSpeaker;
  /** Said while another microphone was speaking too. */
  overlap?: boolean;
};

/** One state line: an icon, what is happening, and optionally why. */
export function Status({
  tone = 'neutral',
  busy,
  title,
  hint,
}: {
  tone?: 'neutral' | 'good' | 'bad';
  busy?: boolean;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2" role={busy ? 'status' : undefined}>
      {busy ? (
        <span
          aria-hidden
          className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin"
        />
      ) : (
        <span
          aria-hidden
          className={`material-symbols-outlined mt-px text-[18px] ${
            tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-error' : 'text-outline'
          }`}
        >
          {tone === 'good' ? 'check_circle' : tone === 'bad' ? 'error' : 'info'}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {hint && <p className="mt-0.5 text-sm text-outline">{hint}</p>}
      </div>
    </div>
  );
}

export function Bullets({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-outline">{empty}</p>;
  return (
    <ul className="space-y-1">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed" dir="auto">
          <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function clock(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** A summary written before study notes (kept readable as it was). */
export function LegacySummaryView({ data }: { data: LegacySummary }) {
  const { t } = useTranslation();
  return (
    <div dir="auto" className="space-y-4">
      <p className="text-sm leading-relaxed">{data.summary}</p>
      {data.topics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.topics.map((tp, i) => (
            <span
              key={i}
              className="rounded-full bg-primary-fixed px-2.5 py-1 text-xs font-semibold text-on-primary-fixed"
            >
              {tp}
            </span>
          ))}
        </div>
      )}
      <Part title={t('summary.keyPoints')}>
        <Bullets items={data.keyPoints} empty={t('summary.noneKeyPoints')} />
      </Part>
      <Part title={t('summary.qa')}>
        {data.questionsAndAnswers.length ? (
          <dl className="space-y-2">
            {data.questionsAndAnswers.map((qa, i) => (
              <div key={i}>
                <dt className="text-sm font-semibold">{qa.question}</dt>
                <dd className="text-sm text-on-surface-variant">{qa.answer}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-outline">{t('summary.noneQa')}</p>
        )}
      </Part>
      <Part title={t('summary.homework')}>
        <Bullets items={data.actionItems} empty={t('summary.noneHomework')} />
      </Part>
    </div>
  );
}

/** A titled part of the study notes, shown only when the class gave it something. */
export function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-bold">{title}</h4>
      {children}
    </div>
  );
}

/**
 * The study notes. A category the class did not touch (no formulas, no
 * homework) is simply not shown — nothing is invented to fill it; homework
 * alone says so, because "was there homework?" is a question students ask.
 */
export function StudyNotesView({ n }: { n: StudyNotes }) {
  const { t } = useTranslation();
  const list = (xs: string[]) => <Bullets items={xs} empty="" />;
  return (
    <div dir="auto" className="space-y-4">
      {n.title && <p className="font-heading text-base font-bold">{n.title}</p>}
      {n.quickSummary && (
        <Part title={t('summary.quick')}>
          <p className="text-sm leading-relaxed">{n.quickSummary}</p>
        </Part>
      )}
      {n.keyPoints.length > 0 && (
        <Part title={t('summary.keyPoints')}>{list(n.keyPoints.map((k) => k.text))}</Part>
      )}
      {n.concepts.length > 0 && (
        <Part title={t('summary.concepts')}>
          <dl className="space-y-1.5">
            {n.concepts.map((c, i) => (
              <div key={i} className="text-sm">
                <dt className="inline font-semibold" dir="auto">
                  {c.term}
                </dt>
                <dd className="inline text-on-surface-variant"> — {c.explanation}</dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
      {n.formulas.length > 0 && (
        <Part title={t('summary.formulas')}>
          <ul className="space-y-1.5">
            {n.formulas.map((fm, i) => (
              <li key={i} className="text-sm">
                <span
                  dir="ltr"
                  className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[13px]"
                >
                  {fm.formula}
                </span>
                <span className="text-on-surface-variant"> — {fm.meaning}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}
      {n.examples.length > 0 && (
        <Part title={t('summary.examples')}>{list(n.examples.map((e) => e.text))}</Part>
      )}
      {n.corrections.length > 0 && (
        <Part title={t('summary.corrections')}>
          {list(
            n.corrections.map((c) =>
              t('summary.correctionLine', { wrong: c.wrong, corrected: c.corrected }),
            ),
          )}
        </Part>
      )}
      {n.questions.length > 0 && (
        <Part title={t('summary.questions')}>
          <dl className="space-y-2">
            {n.questions.map((q, i) => (
              <div key={i}>
                <dt className="text-sm font-semibold">{q.question}</dt>
                <dd className="text-sm text-on-surface-variant">
                  {q.answered && q.answer ? (
                    q.answer
                  ) : (
                    <span className="text-outline">{t('summary.unanswered')}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
      <Part title={t('summary.homework')}>
        {n.homework.length ? (
          list(
            n.homework.map((h) =>
              h.due ? t('summary.homeworkDue', { task: h.task, due: h.due }) : h.task,
            ),
          )
        ) : (
          <p className="text-sm text-outline">{t('summary.noneHomework')}</p>
        )}
      </Part>
      {n.reviewPoints.length > 0 && <Part title={t('summary.review')}>{list(n.reviewPoints)}</Part>}
      {n.studyNotes && (
        <Part title={t('summary.studyNotes')}>
          <p className="whitespace-pre-wrap text-sm leading-7">
            {n.studyNotes.replace(/^#+\s*/gm, '')}
          </p>
        </Part>
      )}
    </div>
  );
}

/** The transcript, readable: by time, searchable, copyable. No speaker names — none are known. */
/** A transcript with speakers: each microphone's consecutive words as one turn. */
function SpeakerTurns({ segments, query }: { segments: Segment[]; query: string }) {
  const { t } = useTranslation();
  const groups = groupBySpeaker(segments);
  return (
    <ol className="space-y-4">
      {groups.map((g, i) => {
        const teacherSide = g.speaker?.kind === 'TEACHER' || g.speaker?.kind === 'STAFF';
        const unknown = !g.speaker || g.speaker.kind === 'UNKNOWN';
        return (
          <li key={i} className="flex gap-3">
            {g.startSec != null && (
              <span dir="ltr" className="mt-0.5 w-12 shrink-0 text-xs tabular-nums text-outline">
                {clock(g.startSec)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                <span
                  className={
                    unknown
                      ? 'text-outline'
                      : teacherSide
                        ? 'text-primary-text'
                        : 'text-on-surface-variant'
                  }
                >
                  {speakerLabel(t, g.speaker)}
                </span>
                {g.overlap && (
                  <span className="rounded-full bg-surface-container-high px-2 py-0.5 font-normal text-outline">
                    {t('record.transcript.speaker.overlap')}
                  </span>
                )}
              </p>
              <p
                dir="auto"
                className="whitespace-pre-wrap text-[15px] leading-8 text-on-surface"
              >
                <Highlight text={g.segments.map((s) => s.text).join(' ')} q={query} />
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function TranscriptViewer({
  segments,
  partial,
  expanded = false,
}: {
  segments: Segment[];
  partial: boolean;
  /** The archive's full view: everything, no "show all" step. */
  expanded?: boolean;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const query = q.trim();
  const shown = useMemo(
    () =>
      query ? segments.filter((s) => s.text.toLowerCase().includes(query.toLowerCase())) : segments,
    [segments, query],
  );
  const visible = query || all || expanded ? shown : shown.slice(0, 3);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(segments.map((s) => s.text).join('\n\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused */
    }
  };
  return (
    <div className="space-y-3">
      {partial && (
        <Status title={t('record.transcript.PARTIAL')} hint={t('record.transcript.partial')} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden
            className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[18px] text-outline"
          >
            search
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('record.transcript.search')}
            aria-label={t('record.transcript.search')}
            className="w-full rounded-xl border border-outline-variant bg-surface py-2 pe-3 ps-9 text-sm"
          />
        </div>
        <button type="button" className="btn-secondary !py-2 text-sm" onClick={copy}>
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            {copied ? 'check' : 'content_copy'}
          </span>
          {copied ? t('record.transcript.copied') : t('record.transcript.copy')}
        </button>
      </div>
      {query && (
        <p className="text-xs text-outline" role="status">
          {t('record.transcript.matches', { count: shown.length })}
        </p>
      )}
      {hasSpeakers(segments) ? (
        <SpeakerTurns segments={visible} query={query} />
      ) : (
      <ol className="space-y-3">
        {visible.map((s, i) => (
          <li key={i} className="flex gap-3">
            {s.startSec != null && (
              <span dir="ltr" className="mt-0.5 w-12 shrink-0 text-xs tabular-nums text-outline">
                {clock(s.startSec)}
              </span>
            )}
            <p
              dir="auto"
              className="min-w-0 flex-1 whitespace-pre-wrap text-[15px] leading-8 text-on-surface"
            >
              <Highlight text={s.text} q={query} />
            </p>
          </li>
        ))}
      </ol>
      )}
      {!query && !expanded && shown.length > 3 && (
        <button
          type="button"
          className="text-xs font-semibold text-primary-text hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? t('record.transcript.showLess') : t('record.transcript.showAll')}
        </button>
      )}
    </div>
  );
}

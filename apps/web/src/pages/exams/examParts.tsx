import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Modal } from '../../components/ui';
import { askConfirm } from '../../lib/confirm';
import {
  ExamStats,
  ExamStatus,
  ExamView,
  formatMarks,
  formatPct,
  newRequestKey,
  parseMarks,
  ResultStatus,
  SheetRow,
  useExamGroups,
  usePaperExamActions,
} from '../../lib/paperExams';
import { dayLabel } from '../fees/feeParts';

export function StatusBadge({ status }: { status: ExamStatus }) {
  const { t } = useTranslation();
  const tone =
    status === 'PUBLISHED'
      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
      : status === 'VOID'
        ? 'bg-error-container text-on-error-container'
        : 'bg-amber-500/15 text-amber-800 dark:text-amber-300';
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}
    >
      {t(`exams.examStatus.${status}`)}
    </span>
  );
}

/** A result as a person reads it: "26.5 / 30", "Absent", "Excused", or "—" (ungraded). */
export function ResultText({ row, maxScore }: { row: Pick<SheetRow, 'result'>; maxScore: number }) {
  const { t } = useTranslation();
  const r = row.result;
  if (!r) return <span className="text-on-surface-variant">{t('exams.ungraded')}</span>;
  if (r.status !== 'SCORED' || r.score == null)
    return (
      <span className="font-semibold text-on-surface-variant">{t(`exams.status.${r.status}`)}</span>
    );
  return (
    <span className="tabular-nums" dir="ltr">
      <span className="font-bold">{formatMarks(r.score)}</span>
      <span className="text-on-surface-variant"> / {formatMarks(maxScore)}</span>
    </span>
  );
}

/** The server's statistics, SCORED results only — this page computes none. */
export function StatsStrip({
  stats,
  exam,
}: {
  stats: ExamStats | null;
  exam: Pick<ExamView, 'maxScore' | 'passScore'>;
}) {
  const { t } = useTranslation();
  if (!stats || !stats.entered) return null;
  const marks = (h: number | null) => (h == null ? '—' : formatMarks(h));
  const cells: [string, string][] = [
    ['average', marks(stats.average)],
    ['median', marks(stats.median)],
    ['highest', marks(stats.highest)],
    ['lowest', marks(stats.lowest)],
    ...(exam.passScore != null && stats.passRateBps != null
      ? ([['passRate', formatPct(stats.passRateBps)]] as [string, string][])
      : []),
  ];
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cells.map(([k, v]) => (
          <div key={k} className="min-w-0 rounded-xl bg-surface-container-low p-3">
            <p className="text-xs text-on-surface-variant">{t(`exams.stats.${k}`)}</p>
            <p className="font-extrabold tabular-nums" dir="ltr">
              {v}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-on-surface-variant">
        {t('exams.stats.counts', {
          scored: stats.scored,
          absent: stats.absent,
          excused: stats.excused,
        })}
        {' · '}
        {t('exams.stats.scoredOnly')}
      </p>
    </div>
  );
}

/** The API's reason for a refused row, in words. */
export function rowErrorText(t: (k: string) => string, code: string) {
  return t(`exams.rowErr.${code}`);
}

/**
 * Leaving with unsaved grades asks first: closing or reloading the tab (the
 * browser's own prompt) and following any link inside the app.
 */
export function useUnsavedGuard(dirty: boolean) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.dataset.unsavedOk) return;
      e.preventDefault();
      e.stopPropagation();
      void askConfirm(t('exams.sheet.unsavedBody'), {
        title: t('exams.sheet.unsavedTitle'),
        confirmLabel: t('exams.sheet.unsavedLeave'),
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        a.dataset.unsavedOk = '1';
        a.click();
        delete a.dataset.unsavedOk;
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, t]);
}

function MarksInput({
  label,
  value,
  onChange,
  required,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: string;
  error?: string | null;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{label}</span>
      <input
        className={`input min-h-11 ${error ? 'field-invalid' : ''}`}
        inputMode="decimal"
        dir="ltr"
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
      {(error || hint) && (
        <span className={`mt-1 block text-xs ${error ? 'text-error' : 'text-on-surface-variant'}`}>
          {error || hint}
        </span>
      )}
    </label>
  );
}

/** Create a paper exam — or edit one (title and note always; date and marks while a draft). */
export function ExamDialog({
  academyId,
  exam,
  defaultGroupId,
  onClose,
  onCreated,
}: {
  academyId: string;
  exam?: ExamView;
  defaultGroupId?: string;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const act = usePaperExamActions(academyId);
  const groups = useExamGroups(academyId, !exam);
  const draft = !exam || exam.status === 'DRAFT';
  const makeup = exam?.kind === 'MAKEUP';
  const [groupId, setGroupId] = useState(defaultGroupId ?? '');
  const [title, setTitle] = useState(exam?.title ?? '');
  const [note, setNote] = useState(exam?.note ?? '');
  const [examDate, setExamDate] = useState(exam?.examDate ?? '');
  const [max, setMax] = useState(exam ? formatMarks(exam.maxScore) : '');
  const [pass, setPass] = useState(exam?.passScore != null ? formatMarks(exam.passScore) : '');
  // One identity for this attempt: a retry or a double click creates one exam.
  const [requestKey] = useState(newRequestKey);
  useEffect(() => {
    if (!groupId && groups.data?.length === 1) setGroupId(groups.data[0].id);
  }, [groups.data, groupId]);
  const maxH = parseMarks(max);
  const passH = pass.trim() ? parseMarks(pass) : null;
  const maxErr = max.trim() && (maxH == null || maxH === 0) ? t('exams.form.marksInvalid') : null;
  const passErr =
    pass.trim() &&
    (passH == null
      ? t('exams.form.marksInvalid')
      : maxH != null && passH > maxH
        ? t('exams.form.passAboveMax')
        : null);
  const ok = !!title.trim() && !!examDate && !!maxH && !maxErr && !passErr && (exam || groupId);
  const m = exam ? act.update : act.create;
  const pending = m.isPending;
  return (
    <Modal
      open
      title={exam ? t('exams.form.editTitle') : t('exams.form.newTitle')}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          if (exam) {
            act.update.mutate(
              {
                id: exam.id,
                title: title.trim(),
                note: note.trim() || null,
                ...(draft && !makeup
                  ? { examDate, maxScore: maxH, passScore: passH }
                  : draft
                    ? { examDate }
                    : {}),
              },
              { onSuccess: onClose },
            );
          } else {
            act.create.mutate(
              {
                requestKey,
                groupId,
                title: title.trim(),
                examDate,
                maxScore: maxH,
                ...(passH != null ? { passScore: passH } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              },
              { onSuccess: (r) => (onCreated ? onCreated(r.exam.id) : onClose()) },
            );
          }
        }}
      >
        {!exam && (
          <label className="mb-3 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('exams.form.group')}
            </span>
            <select
              className="input min-h-11"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              required
            >
              <option value="">{t('exams.form.pickGroup')}</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.title')}
          </span>
          <input
            className="input min-h-11"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.date')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            disabled={!draft}
            required
          />
          <span className="mt-1 block text-xs text-on-surface-variant">
            {t('exams.form.dateHint')}
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <MarksInput
            label={t('exams.form.max')}
            value={max}
            onChange={(v) => !makeup && draft && setMax(v)}
            required
            error={maxErr}
          />
          <MarksInput
            label={t('exams.form.pass')}
            value={pass}
            onChange={(v) => !makeup && draft && setPass(v)}
            hint={t('exams.form.passHint')}
            error={passErr || null}
          />
        </div>
        {(!draft || makeup) && exam && (
          <p className="mb-3 text-xs text-on-surface-variant">
            {makeup ? t('exams.form.makeupMarksFixed') : t('exams.form.publishedFixed')}
          </p>
        )}
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.note')}
          </span>
          <textarea
            className="input min-h-16"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="mt-1 block text-xs text-on-surface-variant">
            {t('exams.form.noteHint')}
          </span>
        </label>
        <ErrorNote error={m.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {exam ? t('common.save') : t('exams.form.create')}
        </button>
      </form>
    </Modal>
  );
}

/** A makeup sitting for those absent or excused in a published exam. */
export function MakeupDialog({
  academyId,
  exam,
  candidates,
  onClose,
  onCreated,
}: {
  academyId: string;
  exam: ExamView;
  candidates: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const act = usePaperExamActions(academyId);
  const [examDate, setExamDate] = useState('');
  const [title, setTitle] = useState(
    t('exams.makeup.defaultTitle', { title: exam.title }).slice(0, 120),
  );
  const [requestKey] = useState(newRequestKey);
  const pending = act.makeup.isPending;
  return (
    <Modal open title={t('exams.makeup.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!examDate || !title.trim() || pending) return;
          act.makeup.mutate(
            { id: exam.id, requestKey, examDate, title: title.trim() },
            { onSuccess: (r) => onCreated(r.exam.id) },
          );
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">
          {t('exams.makeup.who', { count: candidates })}
        </p>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.title')}
          </span>
          <input
            className="input min-h-11"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.form.date')}
          </span>
          <input
            type="date"
            className="input min-h-11"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            required
          />
        </label>
        <p className="mb-3 text-xs text-on-surface-variant">
          {t('exams.makeup.marks', { max: formatMarks(exam.maxScore) })}
        </p>
        <ErrorNote error={act.makeup.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!examDate || pending}
          aria-busy={pending}
        >
          {t('exams.makeup.create')}
        </button>
      </form>
    </Modal>
  );
}

/** Correct a published grade: the new value and why. The old value stays in the history. */
export function CorrectDialog({
  academyId,
  exam,
  row,
  onClose,
}: {
  academyId: string;
  exam: ExamView;
  row: SheetRow;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const act = usePaperExamActions(academyId);
  const r = row.result!;
  const [status, setStatus] = useState<ResultStatus>(r.status);
  const [score, setScore] = useState(r.score != null ? formatMarks(r.score) : '');
  const [reason, setReason] = useState('');
  const h = status === 'SCORED' ? parseMarks(score) : null;
  const scoreErr =
    status === 'SCORED' && score.trim()
      ? h == null
        ? t('exams.form.marksInvalid')
        : h > exam.maxScore
          ? t('exams.sheet.aboveMax', { max: formatMarks(exam.maxScore) })
          : null
      : null;
  const ok = reason.trim().length >= 3 && (status !== 'SCORED' || (h != null && !scoreErr));
  const pending = act.correct.isPending;
  return (
    <Modal open title={t('exams.correct.title', { name: row.fullName })} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          act.correct.mutate(
            {
              id: exam.id,
              academyStudentId: row.academyStudentId,
              version: r.version,
              status,
              ...(status === 'SCORED' ? { score: h! } : {}),
              reason: reason.trim(),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">
          {t('exams.correct.now')} <ResultText row={row} maxScore={exam.maxScore} /> · {exam.title}{' '}
          · {dayLabel(exam.examDate, i18n.language)}
        </p>
        <div className="mb-3 grid grid-cols-3 gap-2" role="radiogroup">
          {(['SCORED', 'ABSENT', 'EXCUSED'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-11 rounded-xl border px-2 text-sm font-semibold ${
                status === s ? 'border-primary bg-primary-fixed/40' : 'border-outline-variant/60'
              }`}
            >
              {t(`exams.status.${s}`)}
            </button>
          ))}
        </div>
        {status === 'SCORED' && (
          <MarksInput
            label={t('exams.correct.score', { max: formatMarks(exam.maxScore) })}
            value={score}
            onChange={setScore}
            required
            error={scoreErr}
          />
        )}
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.correct.reason')}
          </span>
          <textarea
            className="input min-h-20"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          <span className="mt-1 block text-xs text-on-surface-variant">
            {t('exams.correct.reasonHint')}
          </span>
        </label>
        <ErrorNote error={act.correct.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {t('exams.correct.save')}
        </button>
      </form>
    </Modal>
  );
}

/** Void an exam: kept with its reason, excluded from everything. Final. */
export function VoidDialog({
  academyId,
  exam,
  onClose,
}: {
  academyId: string;
  exam: ExamView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const act = usePaperExamActions(academyId);
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 3;
  const pending = act.voidExam.isPending;
  return (
    <Modal open title={t('exams.void.title')} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || pending) return;
          act.voidExam.mutate({ id: exam.id, reason: reason.trim() }, { onSuccess: onClose });
        }}
      >
        <p className="mb-3 text-sm text-on-surface-variant">
          {t('exams.void.body', { title: exam.title })}
        </p>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
            {t('exams.void.reason')}
          </span>
          <textarea
            className="input min-h-20"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            required
            autoFocus
          />
        </label>
        <ErrorNote error={act.voidExam.error} />
        <button
          type="submit"
          className="btn-primary mt-2 min-h-12 w-full !bg-error !text-on-error"
          disabled={!ok || pending}
          aria-busy={pending}
        >
          {t('exams.void.do')}
        </button>
      </form>
    </Modal>
  );
}

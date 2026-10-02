import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorNote, ProgressBar, Spinner } from '../../components/ui';
import { useRegistryAcademyId } from '../../lib/centerStudents';
import { askConfirm, confirmDelete } from '../../lib/confirm';
import { isNetworkFailure } from '../../lib/desk';
import {
  Conflict,
  downloadExamCsv,
  formatMarks,
  formatPct,
  newRequestKey,
  parseMarks,
  ResultStatus,
  RowInput,
  Sheet,
  SheetRow,
  useExamsAcademy,
  usePaperExamActions,
  usePaperExamsAccess,
  useSheet,
} from '../../lib/paperExams';
import { dayLabel } from '../fees/feeParts';
import {
  CorrectDialog,
  ExamDialog,
  MakeupDialog,
  ResultText,
  rowErrorText,
  StatsStrip,
  StatusBadge,
  useUnsavedGuard,
  VoidDialog,
} from './examParts';

/** What the grader has typed for a row and not saved yet. status null = clear the row. */
interface Edit {
  status: ResultStatus | null;
  text: string;
}
type Sort = 'name' | 'code' | 'scoreDesc' | 'ungradedFirst';

const errData = (e: unknown) =>
  ((e as { response?: { data?: Record<string, unknown> } })?.response?.data ?? {}) as {
    code?: string;
    invalid?: { academyStudentId: string; code: string }[];
    learners?: string[];
  };

/**
 * One exam's mark sheet (C6). While a DRAFT: type marks fast (Enter / ↓ to the
 * next learner, A or غ for absent, E or ع for excused), save in one go, then
 * publish once everyone expected has a result. Once PUBLISHED the sheet is
 * frozen; a grade changes only by a correction with a reason. Statistics are
 * the server's.
 */
export default function ExamSheetPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const preferred = useRegistryAcademyId();
  const place = useExamsAcademy(params.get('academy') ?? preferred);
  // Where exams are not mine to see, ask the workspace itself: "no access", not "off".
  const academyId = place.academyId ?? params.get('academy') ?? preferred;
  const access = usePaperExamsAccess(academyId);
  const sheet = useSheet(access.data?.canView ? academyId : undefined, id);
  if (place.loading || access.isLoading || (access.data?.canView && sheet.isLoading))
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  if (!academyId || !access.data?.enabled)
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('exams.off')} hint={t('exams.offHint')} />
      </div>
    );
  if (!access.data.canView)
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('exams.noAccess')} hint={t('exams.noAccessHint')} />
      </div>
    );
  if (sheet.error || !sheet.data)
    return (
      <div className="page">
        <ErrorNote error={sheet.error} />
        <Link
          to={`/center/exams?academy=${academyId}`}
          className="btn-ghost mt-4 inline-flex min-h-11 px-4"
        >
          {t('exams.sheet.back')}
        </Link>
      </div>
    );
  return (
    <SheetView
      key={sheet.data.exam.id}
      academyId={academyId}
      data={sheet.data}
      canManage={access.data.canManage}
      canCorrect={access.data.canCorrect}
    />
  );
}

function SheetView({
  academyId,
  data,
  canManage,
  canCorrect,
}: {
  academyId: string;
  data: Sheet;
  canManage: boolean;
  canCorrect: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const act = usePaperExamActions(academyId);
  const exam = data.exam;
  const draft = exam.status === 'DRAFT';
  const editable = draft && canManage;

  const [edits, setEdits] = useState<Map<string, Edit>>(new Map());
  const [conflicts, setConflicts] = useState<Map<string, Conflict['current']>>(new Map());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<unknown>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [onlyUngraded, setOnlyUngraded] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: 'edit' }
    | { kind: 'makeup' }
    | { kind: 'void' }
    | { kind: 'correct'; row: SheetRow }
    | null
  >(null);
  // One request key per payload: a retry of the same save reuses it (the
  // server answers it once); a different payload gets a new one.
  const attempt = useRef<{ key: string; body: string } | null>(null);
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());

  const dirty = edits.size > 0;
  useUnsavedGuard(dirty);

  const value = (r: SheetRow): Edit =>
    edits.get(r.academyStudentId) ??
    (r.result
      ? { status: r.result.status, text: r.result.score != null ? formatMarks(r.result.score) : '' }
      : { status: null, text: '' });
  const problem = (e: Edit): string | null => {
    if (e.status !== 'SCORED') return null;
    const h = parseMarks(e.text);
    if (h == null) return t('exams.form.marksInvalid');
    if (h > exam.maxScore) return t('exams.sheet.aboveMax', { max: formatMarks(exam.maxScore) });
    return null;
  };

  const setEdit = (r: SheetRow, e: Edit) => {
    setSavedNote(null);
    setMissing((m) => {
      if (!m.has(r.academyStudentId)) return m;
      const n = new Set(m);
      n.delete(r.academyStudentId);
      return n;
    });
    setRowErrors((m) => {
      if (!m.has(r.academyStudentId)) return m;
      const n = new Map(m);
      n.delete(r.academyStudentId);
      return n;
    });
    setEdits((m) => {
      const n = new Map(m);
      const server = r.result
        ? {
            status: r.result.status,
            text: r.result.score != null ? formatMarks(r.result.score) : '',
          }
        : { status: null, text: '' };
      const same =
        e.status === server.status &&
        (e.status !== 'SCORED' || parseMarks(e.text) === parseMarks(server.text));
      if (same && !conflicts.has(r.academyStudentId)) n.delete(r.academyStudentId);
      else n.set(r.academyStudentId, e);
      return n;
    });
  };

  const rows = useMemo(() => {
    const norm = (s: string) =>
      s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
    const needle = norm(q.trim());
    let list = data.rows.filter(
      (r) => !needle || norm(r.fullName).includes(needle) || r.code.toLowerCase().includes(needle),
    );
    // A row that needs the grader — a conflict, a refused mark, a learner the
    // server says is missing — never hides behind the filter.
    const needsYou = (id: string) => conflicts.has(id) || rowErrors.has(id) || missing.has(id);
    // The filter belongs to grading: a published sheet always lists everyone.
    if (onlyUngraded && data.exam.status === 'DRAFT')
      list = list.filter(
        (r) => needsYou(r.academyStudentId) || (!r.result && !edits.has(r.academyStudentId)),
      );
    const score = (r: SheetRow) => r.result?.score ?? -1;
    const sorted = [...list];
    if (sort === 'code') sorted.sort((a, b) => a.code.localeCompare(b.code));
    else if (sort === 'scoreDesc') sorted.sort((a, b) => score(b) - score(a));
    else if (sort === 'ungradedFirst')
      sorted.sort((a, b) => Number(!!a.result) - Number(!!b.result));
    return sorted;
  }, [data.rows, q, sort, onlyUngraded, edits, conflicts, rowErrors, missing]);

  const focusRow = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    const el = r && inputs.current.get(r.academyStudentId);
    if (el) {
      el.focus();
      el.select();
    }
  };

  const invalidCount = [...edits.values()].filter((e) => problem(e)).length;

  const save = () => {
    // An unresolved conflict is decided by a person, never by a second click.
    if (!dirty || invalidCount || conflicts.size || act.save.isPending) return;
    const byId = new Map(data.rows.map((r) => [r.academyStudentId, r]));
    const payload: RowInput[] = [];
    for (const [sid, e] of edits) {
      const r = byId.get(sid);
      if (!r) continue;
      if (e.status === null && !r.result) continue;
      payload.push({
        academyStudentId: sid,
        status: e.status,
        ...(e.status === 'SCORED' ? { score: parseMarks(e.text)! } : {}),
        ...(r.result ? { version: r.result.version } : {}),
      });
    }
    if (!payload.length) {
      setEdits(new Map());
      return;
    }
    const body = JSON.stringify(payload);
    if (!attempt.current || attempt.current.body !== body)
      attempt.current = { key: newRequestKey(), body };
    setSaveError(null);
    setMissing(new Set());
    act.save.mutate(
      { id: exam.id, requestKey: attempt.current.key, rows: payload },
      {
        onSuccess: (res) => {
          attempt.current = null;
          qc.setQueryData(['pe-sheet', academyId, exam.id], res.sheet);
          const c = new Map(res.conflicts.map((x) => [x.academyStudentId, x.current]));
          setConflicts(c);
          setEdits((m) => new Map([...m].filter(([sid]) => c.has(sid))));
          setSavedNote(
            res.replayed
              ? t('exams.sheet.alreadySaved')
              : c.size
                ? t('exams.sheet.savedWithConflicts', { count: c.size })
                : t('exams.sheet.saved', { count: res.saved }),
          );
        },
        onError: (e) => {
          const d = errData(e);
          if (d.code === 'ROWS_INVALID' && d.invalid)
            setRowErrors(new Map(d.invalid.map((x) => [x.academyStudentId, x.code])));
          setSaveError(e);
        },
      },
    );
  };

  const publish = async () => {
    if (dirty) return;
    const ok = await askConfirm(
      t('exams.publish.body', { graded: data.progress.graded, total: data.rows.length }),
      { title: t('exams.publish.title'), confirmLabel: t('exams.publish.do') },
    );
    if (!ok) return;
    setMissing(new Set());
    act.publish.mutate(exam.id, {
      onError: (e) => {
        const d = errData(e);
        if (d.code === 'ROSTER_INCOMPLETE' && d.learners) {
          setMissing(new Set(d.learners));
          setOnlyUngraded(true);
        }
      },
    });
  };

  const remove = async () => {
    if (!(await confirmDelete({ name: exam.title }))) return;
    act.remove.mutate(exam.id, { onSuccess: () => navigate(`/center/exams?academy=${academyId}`) });
  };

  const exportCsv = async () => {
    const { blob, filename } = await downloadExamCsv(academyId, exam.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const absentees = data.rows.filter((r) => r.result && r.result.status !== 'SCORED').length;
  const pct = data.rows.length ? Math.round((data.progress.graded / data.rows.length) * 100) : 0;

  return (
    <div className="page max-w-5xl">
      <Link
        to={`/center/exams?academy=${academyId}`}
        className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary"
      >
        <span className="material-symbols-outlined text-lg rtl:rotate-180" aria-hidden>
          arrow_back
        </span>
        {t('exams.sheet.back')}
      </Link>

      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 font-heading text-2xl font-extrabold sm:text-3xl">{exam.title}</h1>
          <StatusBadge status={exam.status} />
          {exam.kind === 'MAKEUP' && (
            <span className="rounded-full bg-surface-container px-2 py-0.5 text-xs">
              {t('exams.kind.MAKEUP')}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-on-surface-variant">
          {exam.groupName} · {dayLabel(exam.examDate, i18n.language)} ·{' '}
          {t('exams.list.outOf', { max: formatMarks(exam.maxScore) })}
          {exam.passScore != null &&
            ` · ${t('exams.sheet.passMark', { pass: formatMarks(exam.passScore) })}`}
        </p>
        {exam.makeupOf && (
          <p className="mt-1 text-sm">
            {t('exams.sheet.makeupOf')}{' '}
            <Link
              className="inline-flex min-h-11 items-center font-semibold text-primary"
              to={`/center/exams/${exam.makeupOf.id}?academy=${academyId}`}
            >
              {exam.makeupOf.title}
            </Link>
          </p>
        )}
        {exam.makeups.length > 0 && (
          <p className="mt-1 text-sm">
            {t('exams.sheet.makeups')}{' '}
            {exam.makeups.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ' · '}
                <Link
                  className="inline-flex min-h-11 items-center font-semibold text-primary"
                  to={`/center/exams/${m.id}?academy=${academyId}`}
                >
                  {dayLabel(m.examDate, i18n.language)}
                </Link>{' '}
                ({t(`exams.examStatus.${m.status}`)})
              </span>
            ))}
          </p>
        )}
        {exam.note && (
          <p className="mt-2 rounded-xl bg-surface-container-low p-3 text-sm">{exam.note}</p>
        )}
        {exam.status === 'VOID' && (
          <p className="mt-2 rounded-xl bg-error-container/50 p-3 text-sm" role="status">
            {t('exams.sheet.voided', { reason: exam.voidReason ?? '' })}
          </p>
        )}
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {canManage && exam.status !== 'VOID' && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4"
            onClick={() => setDialog({ kind: 'edit' })}
          >
            {t('exams.sheet.edit')}
          </button>
        )}
        {canManage && exam.status === 'PUBLISHED' && exam.kind === 'REGULAR' && absentees > 0 && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4"
            onClick={() => setDialog({ kind: 'makeup' })}
          >
            {t('exams.makeup.open')}
          </button>
        )}
        <button type="button" className="btn-ghost min-h-11 px-4" onClick={() => void exportCsv()}>
          {t('exams.sheet.export')}
        </button>
        {canCorrect && exam.status !== 'VOID' && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4 text-error"
            onClick={() => setDialog({ kind: 'void' })}
          >
            {t('exams.void.open')}
          </button>
        )}
        {canManage && draft && data.progress.graded === 0 && (
          <button
            type="button"
            className="btn-ghost min-h-11 px-4 text-error"
            onClick={() => void remove()}
          >
            {t('exams.sheet.delete')}
          </button>
        )}
      </div>
      <ErrorNote error={act.remove.error} />

      <StatsStrip stats={data.stats} exam={exam} />

      {draft && (
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-semibold">
              {t('exams.sheet.progress', { graded: data.progress.graded, total: data.rows.length })}
            </span>
            {dirty && (
              <span className="text-amber-700 dark:text-amber-300">
                {t('exams.sheet.unsaved', { count: edits.size })}
              </span>
            )}
          </div>
          <ProgressBar pct={pct} />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-48">
          <span className="sr-only">{t('exams.sheet.search')}</span>
          <input
            className="input min-h-11"
            type="search"
            placeholder={t('exams.sheet.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="min-w-0 basis-40">
          <span className="sr-only">{t('exams.sheet.sort')}</span>
          <select
            className="input min-h-11"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            {(['name', 'code', 'scoreDesc', 'ungradedFirst'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`exams.sheet.sortBy.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {draft && (
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              className="size-5"
              checked={onlyUngraded}
              onChange={(e) => setOnlyUngraded(e.target.checked)}
            />
            {t('exams.sheet.onlyUngraded')}
          </label>
        )}
      </div>
      {editable && (
        <p className="mb-2 hidden text-xs text-on-surface-variant sm:block">
          {t('exams.sheet.keysHint')}
        </p>
      )}

      {!data.rows.length ? (
        <EmptyState
          icon="group_off"
          title={t(exam.kind === 'MAKEUP' ? 'exams.sheet.noCandidates' : 'exams.sheet.noRoster')}
        />
      ) : !rows.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">
          {t('exams.sheet.noMatch')}
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/40 rounded-2xl border border-outline-variant/50">
          {rows.map((r, i) => {
            const v = value(r);
            const err = rowErrors.get(r.academyStudentId);
            const bad = editable ? problem(v) : null;
            const conflict = conflicts.get(r.academyStudentId);
            const hasConflict = conflicts.has(r.academyStudentId);
            const isMissing = missing.has(r.academyStudentId);
            return (
              <li
                key={r.academyStudentId}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 p-3 ${
                  edits.has(r.academyStudentId) ? 'bg-amber-500/5' : ''
                } ${isMissing || err || bad ? 'bg-error-container/30' : ''}`}
              >
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate font-semibold">{r.fullName}</span>
                  <span className="block text-xs text-on-surface-variant">
                    <span className="font-mono" dir="ltr">
                      {r.code}
                    </span>
                    {r.result?.guest && ` · ${t('exams.sheet.guest')}`}
                    {r.learnerStatus !== 'ACTIVE' && ` · ${t('exams.sheet.withdrawn')}`}
                    {r.result?.corrected && ` · ${t('exams.sheet.corrected')}`}
                  </span>
                </span>
                {editable ? (
                  <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(r.academyStudentId, el);
                        else inputs.current.delete(r.academyStudentId);
                      }}
                      aria-label={t('exams.sheet.scoreFor', { name: r.fullName })}
                      className={`input min-h-11 w-24 text-center tabular-nums ${bad ? 'field-invalid' : ''}`}
                      inputMode="decimal"
                      dir="ltr"
                      placeholder={
                        v.status === 'ABSENT' || v.status === 'EXCUSED'
                          ? t(`exams.status.${v.status}`)
                          : '—'
                      }
                      value={v.status === 'SCORED' ? v.text : ''}
                      onChange={(e) => {
                        const text = e.target.value;
                        setEdit(
                          r,
                          text.trim() ? { status: 'SCORED', text } : { status: null, text: '' },
                        );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          focusRow(i + 1);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          focusRow(i - 1);
                        } else if (['a', 'A', 'غ'].includes(e.key)) {
                          e.preventDefault();
                          setEdit(r, { status: 'ABSENT', text: '' });
                          focusRow(i + 1);
                        } else if (['e', 'E', 'ع'].includes(e.key)) {
                          e.preventDefault();
                          setEdit(r, { status: 'EXCUSED', text: '' });
                          focusRow(i + 1);
                        } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                          e.preventDefault();
                          save();
                        }
                      }}
                    />
                    <span className="text-sm text-on-surface-variant" dir="ltr">
                      / {formatMarks(exam.maxScore)}
                    </span>
                    {(['ABSENT', 'EXCUSED'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={v.status === s}
                        onClick={() =>
                          setEdit(
                            r,
                            v.status === s ? { status: null, text: '' } : { status: s, text: '' },
                          )
                        }
                        className={`min-h-11 rounded-xl border px-3 text-xs font-semibold ${
                          v.status === s
                            ? 'border-primary bg-primary-fixed/40'
                            : 'border-outline-variant/60'
                        }`}
                      >
                        {t(`exams.status.${s}`)}
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-end">
                      <ResultText row={r} maxScore={exam.maxScore} />
                      {r.result?.pctBps != null && (
                        <span className="block text-xs text-on-surface-variant" dir="ltr">
                          {formatPct(r.result.pctBps)}
                          {r.result.passed != null &&
                            ` · ${t(r.result.passed ? 'exams.passed' : 'exams.failed')}`}
                        </span>
                      )}
                    </span>
                    {canCorrect && exam.status === 'PUBLISHED' && r.result && (
                      <button
                        type="button"
                        className="btn-ghost min-h-11 px-3 text-xs"
                        onClick={() => setDialog({ kind: 'correct', row: r })}
                      >
                        {t('exams.correct.open')}
                      </button>
                    )}
                  </span>
                )}
                {(bad || err || isMissing) && (
                  <span className="w-full text-xs text-error" role="alert">
                    {bad || (err ? rowErrorText(t, err) : t('exams.sheet.missing'))}
                  </span>
                )}
                {hasConflict && (
                  <span
                    className="flex w-full flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 p-2 text-xs"
                    role="alert"
                  >
                    <span className="min-w-0 flex-1">
                      {conflict
                        ? t('exams.sheet.conflict', {
                            value:
                              conflict.status === 'SCORED' && conflict.score != null
                                ? formatMarks(conflict.score)
                                : t(`exams.status.${conflict.status}`),
                          })
                        : t('exams.sheet.conflictCleared')}
                    </span>
                    <button
                      type="button"
                      className="btn-ghost min-h-9 px-3"
                      onClick={() =>
                        setConflicts((m) => {
                          const n = new Map(m);
                          n.delete(r.academyStudentId);
                          return n;
                        })
                      }
                    >
                      {t('exams.sheet.keepMine')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-9 px-3"
                      onClick={() => {
                        setConflicts((m) => {
                          const n = new Map(m);
                          n.delete(r.academyStudentId);
                          return n;
                        });
                        setEdits((m) => {
                          const n = new Map(m);
                          n.delete(r.academyStudentId);
                          return n;
                        });
                      }}
                    >
                      {t('exams.sheet.useTheirs')}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 mt-4 rounded-2xl border border-outline-variant bg-surface-container-lowest p-3 shadow-lg lg:bottom-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm" role="status" aria-live="polite">
              {saveError ? (
                isNetworkFailure(saveError) ? (
                  <span className="text-error">{t('exams.sheet.offline')}</span>
                ) : (
                  <ErrorNote error={saveError} />
                )
              ) : conflicts.size ? (
                <span className="text-amber-700 dark:text-amber-300">
                  {t('exams.sheet.resolveFirst', { count: conflicts.size })}
                </span>
              ) : invalidCount ? (
                <span className="text-error">
                  {t('exams.sheet.fixFirst', { count: invalidCount })}
                </span>
              ) : savedNote ? (
                savedNote
              ) : dirty ? (
                t('exams.sheet.unsaved', { count: edits.size })
              ) : (
                t('exams.sheet.allSaved')
              )}
            </span>
            <button
              type="button"
              className="btn-primary min-h-12 px-5"
              disabled={!dirty || !!invalidCount || conflicts.size > 0 || act.save.isPending}
              aria-busy={act.save.isPending}
              onClick={save}
            >
              {t('exams.sheet.save')}
            </button>
            <button
              type="button"
              className="btn-ghost min-h-12 px-5"
              disabled={dirty || act.publish.isPending || data.progress.graded === 0}
              aria-busy={act.publish.isPending}
              title={dirty ? t('exams.publish.saveFirst') : undefined}
              onClick={() => void publish()}
            >
              {t('exams.publish.do')}
            </button>
          </div>
          {act.publish.error != null && (
            <div>
              <ErrorNote error={act.publish.error} />
            </div>
          )}
        </div>
      )}

      {dialog?.kind === 'edit' && (
        <ExamDialog academyId={academyId} exam={exam} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'makeup' && (
        <MakeupDialog
          academyId={academyId}
          exam={exam}
          candidates={absentees}
          onClose={() => setDialog(null)}
          onCreated={(mid) => {
            setDialog(null);
            navigate(`/center/exams/${mid}?academy=${academyId}`);
          }}
        />
      )}
      {dialog?.kind === 'void' && (
        <VoidDialog academyId={academyId} exam={exam} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'correct' && (
        <CorrectDialog
          academyId={academyId}
          exam={exam}
          row={dialog.row}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

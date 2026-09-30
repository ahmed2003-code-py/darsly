import { ChangeEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Pager from '../../components/Pager';
import { Badge, EmptyState, ErrorNote, PageHeader, Spinner } from '../../components/ui';
import {
  ImportBatch,
  ImportPreview,
  ImportPreviewRow,
  fetchImport,
  localPhone,
  useCommitImport,
  usePreviewImport,
  useRegistryAccess,
  useRegistryAcademyId,
} from '../../lib/centerStudents';
import {
  MAX_SHEET_BYTES,
  MAX_SHEET_ROWS,
  SHEET_FIELDS,
  SheetProblem,
  TEMPLATE_HEADERS,
  parseCsv,
  rowsFromSheet,
} from '../../lib/studentSheet';

type Filter = 'ALL' | ImportPreviewRow['status'];
const PAGE = 100;

/**
 * Bringing a center's existing spreadsheet onto the register.
 *
 * The file is opened here, in the browser, and only its cells are sent — as
 * text. The server reads every row by the same rules as a desk registration
 * and answers with what it WOULD do; nothing is written until "import" is
 * pressed, and pressing it again (or retrying after a dropped connection)
 * cannot import anyone twice.
 */
export default function StudentImportPage() {
  const { t } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useRegistryAccess(academyId);
  const preview = usePreviewImport(academyId);
  const commit = useCommitImport(academyId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState<
    SheetProblem | { code: 'TOO_BIG' | 'BAD_TYPE' | 'UNREADABLE' } | null
  >(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [waiting, setWaiting] = useState(false);

  const p: ImportPreview | undefined = preview.data;
  const shown = useMemo(
    () => (p ? p.rows.filter((r) => filter === 'ALL' || r.status === filter) : []),
    [p, filter],
  );

  if (!academyId || access.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!access.data?.canRegister) {
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('registry.noAccess')} hint={t('registry.noAccessHint')} />
      </div>
    );
  }

  const downloadTemplate = async () => {
    const { default: writeXlsxFile } = await import('write-excel-file/browser');
    const header = SHEET_FIELDS.map((f) => ({
      value: TEMPLATE_HEADERS[f],
      fontWeight: 'bold' as const,
    }));
    const example = [
      'أحمد محمد علي',
      '01012345678',
      'محمد علي',
      '01112345678',
      'مدرسة النصر',
      '3 ثانوي',
      '',
    ];
    await writeXlsxFile([header, example.map((v) => ({ value: v, type: String }))], {
      sheet: 'الطلاب',
      rightToLeft: true,
      columns: SHEET_FIELDS.map(() => ({ width: 22 })),
    }).toFile('darsly-students-template.xlsx');
  };

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // choosing the same file again must fire again
    if (!file || reading || preview.isPending) return;
    setProblem(null);
    setIgnored([]);
    setResult(null);
    preview.reset();
    commit.reset();
    setFileName(file.name);
    if (file.size > MAX_SHEET_BYTES) return setProblem({ code: 'TOO_BIG' });
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext !== 'xlsx' && ext !== 'csv') return setProblem({ code: 'BAD_TYPE' });
    setReading(true);
    try {
      let data: unknown[][];
      if (ext === 'csv') {
        data = parseCsv(await file.text());
      } else {
        // The library reads cell values only: formulas are not evaluated and
        // macros never run; a file that is not really a workbook is refused.
        const { default: readXlsxFile } = await import('read-excel-file/browser');
        const sheets = await readXlsxFile(file);
        data = (sheets[0]?.data ?? []) as unknown[][];
      }
      const read = rowsFromSheet(data);
      setIgnored(read.ignored);
      if (read.problem) return setProblem(read.problem);
      setFilter('ALL');
      setPage(1);
      preview.mutate({ fileName: file.name, rows: read.rows });
    } catch {
      setProblem({ code: 'UNREADABLE' });
    } finally {
      setReading(false);
    }
  };

  /** Commit; if another commit of this batch is running, wait for its outcome instead of racing it. */
  const doCommit = () => {
    if (!p || commit.isPending || waiting) return;
    commit.mutate(p.id, {
      onSuccess: setResult,
      onError: async (e) => {
        const code = (e as { response?: { data?: { code?: string } } }).response?.data?.code;
        if (code !== 'IMPORT_COMMIT_IN_PROGRESS') return;
        setWaiting(true);
        try {
          for (let i = 0; i < 90; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const b = await fetchImport(academyId, p.id).catch(() => null);
            if (b?.status === 'COMMITTED') {
              commit.reset();
              setResult(b);
              return;
            }
          }
        } finally {
          setWaiting(false);
        }
      },
    });
  };

  const downloadResults = async () => {
    if (!p || !result?.results) return;
    const { default: writeXlsxFile } = await import('write-excel-file/browser');
    const nameOf = new Map(p.rows.map((r) => [r.row, r.data.fullName]));
    const rows = [
      [
        t('registry.imp.colRow'),
        t('registry.imp.colName'),
        t('registry.imp.colCode'),
        t('registry.imp.colOutcome'),
      ].map((value) => ({ value, fontWeight: 'bold' as const })),
      ...result.results.map((r) => [
        { value: r.row, type: Number },
        { value: nameOf.get(r.row) ?? '', type: String },
        { value: r.code ?? '', type: String },
        {
          value:
            r.status === 'CREATED'
              ? t('registry.imp.created')
              : t(`registry.issue.${r.reason ?? 'ALREADY_REGISTERED'}`),
          type: String,
        },
      ]),
    ];
    await writeXlsxFile(rows as never, {
      rightToLeft: true,
      columns: [{ width: 8 }, { width: 28 }, { width: 12 }, { width: 30 }],
    }).toFile('darsly-import-result.xlsx');
  };

  const busy = reading || preview.isPending;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));

  return (
    <div className="page">
      <PageHeader
        title={t('registry.imp.title')}
        subtitle={t('registry.imp.subtitle', { max: MAX_SHEET_ROWS })}
        action={
          <Link
            className="btn-ghost px-4 py-2.5 text-sm"
            to={`/center/students?academy=${academyId}`}
          >
            {t('registry.imp.back')}
          </Link>
        }
      />

      {!result && (
        <section className="card mb-6 p-5">
          <ol className="mb-5 grid gap-2 text-sm text-on-surface-variant sm:grid-cols-3">
            <li>
              <b className="text-on-surface">1.</b> {t('registry.imp.step1')}
            </li>
            <li>
              <b className="text-on-surface">2.</b> {t('registry.imp.step2')}
            </li>
            <li>
              <b className="text-on-surface">3.</b> {t('registry.imp.step3')}
            </li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary px-4 py-2.5 text-sm" onClick={downloadTemplate}>
              <span aria-hidden className="material-symbols-outlined align-middle text-lg">
                download
              </span>{' '}
              {t('registry.imp.template')}
            </button>
            <button
              className="btn-primary px-5 py-2.5 text-sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              aria-busy={busy}
            >
              <span aria-hidden className="material-symbols-outlined align-middle text-lg">
                upload_file
              </span>{' '}
              {busy ? t('registry.imp.reading') : t('registry.imp.choose')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="sr-only"
              onChange={choose}
              aria-label={t('registry.imp.choose')}
              tabIndex={-1}
            />
          </div>
          {fileName && <p className="mt-3 text-sm text-outline">{fileName}</p>}
          {problem && (
            <p
              role="alert"
              className="mt-3 rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container"
            >
              {problem.code === 'TOO_MANY_ROWS'
                ? t('registry.sheet.TOO_MANY_ROWS', { count: problem.count, max: MAX_SHEET_ROWS })
                : problem.code === 'DUPLICATE_COLUMNS'
                  ? t('registry.sheet.DUPLICATE_COLUMNS', {
                      columns: problem.fields.map((f) => TEMPLATE_HEADERS[f]).join('، '),
                    })
                  : t(`registry.sheet.${problem.code}`)}
            </p>
          )}
          {ignored.length > 0 && !problem && (
            <p className="mt-3 text-sm text-on-surface-variant">
              {t('registry.imp.ignored', { columns: ignored.join('، ') })}
            </p>
          )}
          <ErrorNote error={preview.error} />
        </section>
      )}

      {p && !result && (
        <section aria-labelledby="imp-preview">
          <h2 id="imp-preview" className="mb-3 font-heading text-lg font-bold">
            {t('registry.imp.previewTitle')}
          </h2>
          {p.alreadyImportedAt && (
            <p
              role="status"
              className="mb-3 rounded-xl border border-amber-600/20 bg-amber-50 px-4 py-2 text-sm text-amber-900"
            >
              {t('registry.imp.already', {
                date: new Date(p.alreadyImportedAt).toLocaleDateString(),
              })}
            </p>
          )}
          <div
            role="tablist"
            aria-label={t('registry.imp.filter')}
            className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
          >
            {(['ALL', 'OK', 'WARNING', 'ERROR', 'DUPLICATE'] as Filter[]).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                className={`min-h-10 shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold ${
                  filter === f
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container-low text-on-surface-variant'
                }`}
                onClick={() => {
                  setFilter(f);
                  setPage(1);
                }}
              >
                {t(`registry.imp.f.${f}`)} ·{' '}
                <span className="tabular-nums">{f === 'ALL' ? p.totalRows : p.counts[f]}</span>
              </button>
            ))}
          </div>

          {/* One card per row below xl: the table's six columns squeezed into
              a phone (or a laptop with the sidebar open) clipped the numbers
              and pushed the reason off-screen. */}
          <ul className="grid gap-2 xl:hidden">
            {shown.slice((page - 1) * PAGE, page * PAGE).map((r) => (
              <li
                key={r.row}
                className={`card p-3.5 ${r.status === 'ERROR' ? 'border-error/30 bg-error-container/20' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-semibold leading-snug [overflow-wrap:anywhere]">
                    <bdi>{r.data.fullName || '—'}</bdi>
                  </p>
                  <span className="shrink-0 text-xs text-outline">
                    {t('registry.imp.rowN', { n: r.row })}
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-on-surface-variant">
                  {r.data.guardianPhone && (
                    <span dir="ltr" className="tabular-nums">
                      {localPhone(r.data.guardianPhone)}
                    </span>
                  )}
                  {r.data.gradeName && <span>{r.data.gradeName}</span>}
                  {r.data.groupName && <bdi>{r.data.groupName}</bdi>}
                </p>
                <div className="mt-2">
                  <RowOutcome r={r} />
                </div>
              </li>
            ))}
          </ul>
          <div className="card hidden overflow-x-auto p-0 xl:block">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface-container-low text-start text-xs text-on-surface-variant">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.imp.colRow')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.imp.colName')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.guardian')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.form.grade')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.form.group')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    {t('registry.imp.colOutcome')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/40">
                {shown.slice((page - 1) * PAGE, page * PAGE).map((r) => (
                  <tr key={r.row} className={r.status === 'ERROR' ? 'bg-error-container/30' : ''}>
                    <td className="px-3 py-2 tabular-nums text-outline">{r.row}</td>
                    <td className="min-w-[9rem] px-3 py-2 font-semibold [overflow-wrap:anywhere]">
                      <bdi>{r.data.fullName || '—'}</bdi>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span dir="ltr" className="tabular-nums">
                        {localPhone(r.data.guardianPhone) || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{r.data.gradeName ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">{r.data.groupName ?? '—'}</td>
                    <td className="px-3 py-2">
                      <RowOutcome r={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} onGo={setPage} />

          <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 mt-6 flex lg:bottom-3 flex-col items-stretch gap-2 rounded-2xl border border-outline-variant bg-surface-container-lowest p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-on-surface-variant">
              {p.validRows
                ? t('registry.imp.ready', { count: p.validRows })
                : t('registry.imp.nothing')}
            </p>
            <button
              className="btn-primary px-6 py-3"
              onClick={doCommit}
              disabled={!p.validRows || commit.isPending || waiting}
              aria-busy={commit.isPending || waiting}
            >
              {commit.isPending || waiting
                ? t('registry.imp.committing')
                : t('registry.imp.commit', { count: p.validRows })}
            </button>
          </div>
          {commit.error &&
            (commit.error as { response?: { data?: { code?: string } } }).response?.data?.code !==
              'IMPORT_COMMIT_IN_PROGRESS' && (
              <div className="mt-3">
                <ErrorNote error={commit.error} />
                <p className="mt-2 text-sm text-on-surface-variant">
                  {t('registry.imp.retrySafe')}
                </p>
              </div>
            )}
        </section>
      )}

      {result && (
        <section className="card p-6 text-center" role="status">
          <span aria-hidden className="material-symbols-outlined text-5xl text-primary">
            task_alt
          </span>
          <h2 className="mt-2 font-heading text-xl font-bold">{t('registry.imp.doneTitle')}</h2>
          <p className="mt-2 text-on-surface-variant">
            {t('registry.imp.doneCreated', { count: result.createdCount })}
            {result.skippedCount > 0 && (
              <> · {t('registry.imp.doneSkipped', { count: result.skippedCount })}</>
            )}
          </p>
          <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
            <button className="btn-secondary px-5 py-2.5" onClick={downloadResults}>
              {t('registry.imp.downloadResult')}
            </button>
            <Link className="btn-primary px-5 py-2.5" to={`/center/students?academy=${academyId}`}>
              {t('registry.imp.toStudents')}
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

/** A row's verdict and its reasons, in the operator's words — table and card alike. */
function RowOutcome({ r }: { r: ImportPreviewRow }) {
  const { t } = useTranslation();
  return (
    <>
      <Badge
        tone={
          r.status === 'OK'
            ? 'primary'
            : r.status === 'ERROR'
              ? 'error'
              : r.status === 'DUPLICATE'
                ? 'neutral'
                : 'warn'
        }
      >
        {t(`registry.imp.f.${r.status}`)}
      </Badge>
      {r.issues.map((i) => (
        <span key={`${i.field}-${i.code}`} className="mt-1 block text-xs text-on-surface-variant">
          {i.code === 'ALREADY_REGISTERED' && r.existing ? (
            <>
              {t('registry.imp.existingAs')}{' '}
              <bdi className="font-mono tabular-nums">{r.existing.code}</bdi>
            </>
          ) : (
            t(`registry.issue.${i.code}`, { field: t(`registry.field.${i.field}`) })
          )}
        </span>
      ))}
    </>
  );
}

import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Pager from '../../components/Pager';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
  Skeleton,
  Spinner,
} from '../../components/ui';
import {
  DuplicateCandidate,
  RegistryStatus,
  RegistryStudent,
  downloadRegistryCsv,
  localPhone,
  newRequestKey,
  useAddStudentToGroup,
  useRegisterStudent,
  useRegistryAccess,
  useRegistryAcademyId,
  useRegistryGroups,
  useRegistryList,
  useSetStudentStatus,
  useUpdateStudent,
} from '../../lib/centerStudents';
import { confirmDelete } from '../../lib/confirm';
import { errorMessage } from '../../lib/errorMessage';
import { useToastStore } from '../../lib/toast';
import StudentForm, { EMPTY_STUDENT, StudentFormValues } from './StudentForm';

/**
 * The Center's students — the desk's first screen.
 *
 * Built for someone at a counter with a family waiting: the search box has
 * focus on arrival and takes whatever is at hand — the code on a card, part
 * of a name, the student's or the parent's number, in Arabic or Latin digits.
 * Everything else is one tap from a row. No finance: C1 has none.
 */
export default function CenterStudentsPage() {
  const { t } = useTranslation();
  const academyId = useRegistryAcademyId();
  const access = useRegistryAccess(academyId);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [status, setStatus] = useState<RegistryStatus | 'ALL'>('ACTIVE');
  const [page, setPage] = useState(1);
  const canView = !!access.data?.canView;
  const canRegister = !!access.data?.canRegister;
  const list = useRegistryList(academyId, { q: query, status, page }, canView);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RegistryStudent | null>(null);
  const [grouping, setGrouping] = useState<RegistryStudent | null>(null);
  const [exporting, setExporting] = useState(false);
  const push = useToastStore((s) => s.push);
  const statusMut = useSetStudentStatus(academyId);

  useEffect(() => setPage(1), [query, status]);

  if (!academyId || access.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!access.data?.enabled) {
    return (
      <div className="page">
        <EmptyState icon="toggle_off" title={t('registry.off')} hint={t('registry.offHint')} />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="page">
        <EmptyState icon="lock" title={t('registry.noAccess')} hint={t('registry.noAccessHint')} />
      </div>
    );
  }

  const setStudentStatus = async (s: RegistryStudent, to: 'withdraw' | 'reactivate') => {
    if (statusMut.isPending) return;
    if (to === 'withdraw') {
      const ok = await confirmDelete({
        kind: 'remove',
        title: t('registry.withdrawTitle'),
        message: t('registry.withdrawBody', { name: s.fullName }),
        confirmLabel: t('registry.withdraw'),
      });
      if (!ok) return;
    }
    const res = await statusMut.mutateAsync({ id: s.id, to }).catch(() => null);
    if (res?.changed) {
      push({
        tone: 'success',
        message: t(to === 'withdraw' ? 'registry.withdrawn' : 'registry.reactivated', {
          name: s.fullName,
        }),
      });
    }
  };

  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadRegistryCsv(academyId, status);
    } catch (e) {
      push({ tone: 'error', message: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="page">
      <PageHeader
        title={t('registry.title')}
        subtitle={t('registry.subtitle')}
        action={
          <div className="flex flex-wrap gap-2">
            {canRegister && (
              <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setCreating(true)}>
                <span aria-hidden className="material-symbols-outlined align-middle text-lg">
                  person_add
                </span>{' '}
                {t('registry.new')}
              </button>
            )}
            {canRegister && (
              <Link
                className="btn-secondary px-4 py-2.5 text-sm"
                to={`/center/students/import?academy=${academyId}`}
              >
                <span aria-hidden className="material-symbols-outlined align-middle text-lg">
                  upload_file
                </span>{' '}
                {t('registry.import')}
              </Link>
            )}
            <button
              className="btn-ghost px-4 py-2.5 text-sm"
              onClick={doExport}
              disabled={exporting}
              aria-busy={exporting}
            >
              <span aria-hidden className="material-symbols-outlined align-middle text-lg">
                download
              </span>{' '}
              {t('registry.export')}
            </button>
          </div>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <span
            aria-hidden
            className="material-symbols-outlined pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-xl text-outline"
          >
            search
          </span>
          <input
            type="search"
            className="w-full rounded-2xl border border-outline-variant bg-surface-container-lowest py-3.5 pe-4 ps-12 text-base outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            placeholder={t('registry.searchPh')}
            aria-label={t('registry.searchPh')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            enterKeyHint="search"
          />
        </div>
        <div
          role="tablist"
          aria-label={t('registry.statusFilter')}
          className="flex shrink-0 rounded-2xl bg-surface-container-low p-1"
        >
          {(['ACTIVE', 'WITHDRAWN', 'ALL'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={status === s}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
                status === s
                  ? 'bg-surface-container-lowest text-on-surface shadow-sm'
                  : 'text-on-surface-variant'
              }`}
              onClick={() => setStatus(s)}
            >
              {t(`registry.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {list.error ? (
        <ErrorNote error={list.error} />
      ) : !data ? (
        <div className="grid gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={query ? 'person_search' : status === 'WITHDRAWN' ? 'how_to_reg' : 'groups'}
          title={
            query
              ? t('registry.noMatch')
              : status === 'WITHDRAWN'
                ? t('registry.emptyWithdrawn')
                : t('registry.empty')
          }
          hint={
            query
              ? t('registry.noMatchHint')
              : status === 'WITHDRAWN'
                ? t('registry.emptyWithdrawnHint')
                : canRegister
                  ? t('registry.emptyHint')
                  : undefined
          }
        />
      ) : (
        <>
          <p className="mb-2 text-sm text-on-surface-variant" aria-live="polite">
            {t('registry.count', { count: data.total })}
          </p>
          <ul className={`grid gap-2 transition-opacity ${list.isFetching ? 'opacity-70' : ''}`}>
            {data.items.map((s) => (
              <StudentRow
                key={s.id}
                s={s}
                academyId={academyId}
                canRegister={canRegister}
                busy={statusMut.isPending && statusMut.variables?.id === s.id}
                onEdit={() => setEditing(s)}
                onGroup={() => setGrouping(s)}
                onStatus={(to) => setStudentStatus(s, to)}
              />
            ))}
          </ul>
          <Pager page={page} pages={pages} onGo={setPage} />
        </>
      )}

      {creating && <NewStudentModal academyId={academyId} onClose={() => setCreating(false)} />}
      {editing && (
        <EditStudentModal
          academyId={academyId}
          student={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {grouping && (
        <AddToGroupModal
          academyId={academyId}
          student={grouping}
          onClose={() => setGrouping(null)}
        />
      )}
    </div>
  );
}

function StudentRow({
  s,
  academyId,
  canRegister,
  busy,
  onEdit,
  onGroup,
  onStatus,
}: {
  s: RegistryStudent;
  academyId: string;
  canRegister: boolean;
  busy: boolean;
  onEdit: () => void;
  onGroup: () => void;
  onStatus: (to: 'withdraw' | 'reactivate') => void;
}) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  const withdrawn = s.status === 'WITHDRAWN';
  const [menu, setMenu] = useState(false);
  const profile = `/staff/students/${s.studentId}?academy=${academyId}`;
  const meta = [s.grade ? (ar ? s.grade.nameAr : s.grade.nameEn) : null, s.school].filter(
    (x): x is string => !!x,
  );
  // One compact card at every width: who (code, name), then only the facts
  // this student actually has — no repeated labels, no "—" placeholders. A
  // receptionist scanning dozens of students reads five or six per phone
  // screen instead of two. Actions sit beside the card on a wide screen and
  // behind one ⋯ button on a phone.
  return (
    <li className={`card p-3.5 sm:p-4 ${withdrawn ? 'opacity-80' : ''}`}>
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 rounded-lg bg-primary-fixed px-2 py-1 font-mono text-[0.95rem] font-bold tracking-wider text-on-primary-fixed tabular-nums"
          dir="ltr"
          aria-label={t('registry.codeLabel', { code: s.code })}
        >
          {s.code}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            className="-my-2 block py-2 font-heading text-base font-bold leading-snug [overflow-wrap:anywhere] hover:underline"
            to={profile}
          >
            <bdi>{s.fullName}</bdi>
          </Link>
          {(meta.length > 0 || withdrawn) && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-on-surface-variant">
              {meta.map((m, i) => (
                <span key={i} className="[overflow-wrap:anywhere]">
                  {i > 0 && (
                    <span aria-hidden className="me-2 text-outline">
                      ·
                    </span>
                  )}
                  {m}
                </span>
              ))}
              {withdrawn && <Badge tone="warn">{t('registry.status.WITHDRAWN')}</Badge>}
            </p>
          )}
          {(s.guardianPhone || s.studentPhone) && (
            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {s.guardianPhone && (
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="text-xs text-outline">{t('registry.guardian')}</span>
                  <span dir="ltr" className="tabular-nums">
                    {localPhone(s.guardianPhone)}
                  </span>
                </span>
              )}
              {s.studentPhone && (
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="text-xs text-outline">{t('registry.studentShort')}</span>
                  <span dir="ltr" className="tabular-nums">
                    {localPhone(s.studentPhone)}
                  </span>
                </span>
              )}
            </p>
          )}
          {s.groups.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5" aria-label={t('registry.groups')}>
              {s.groups.map((g) => (
                <Badge key={g.id} tone="primary">
                  <bdi>{g.name}</bdi>
                </Badge>
              ))}
            </p>
          )}
        </div>
        {canRegister && (
          <>
            <button
              className="-me-1.5 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-on-surface-variant hover:bg-surface-container-low md:hidden"
              onClick={() => setMenu(true)}
              aria-label={t('registry.actionsFor', { name: s.fullName })}
              aria-haspopup="dialog"
            >
              <span aria-hidden className="material-symbols-outlined">
                more_vert
              </span>
            </button>
            <div className="hidden shrink-0 flex-wrap items-center justify-end gap-1.5 md:flex">
              {!withdrawn && (
                <button className="btn-secondary px-3 py-2 text-sm" onClick={onGroup}>
                  {t('registry.addToGroup')}
                </button>
              )}
              <button className="btn-ghost px-3 py-2 text-sm" onClick={onEdit}>
                {t('registry.edit')}
              </button>
              <button
                className={`btn-ghost px-3 py-2 text-sm ${withdrawn ? '' : 'text-error'}`}
                onClick={() => onStatus(withdrawn ? 'reactivate' : 'withdraw')}
                disabled={busy}
                aria-busy={busy}
              >
                {withdrawn ? t('registry.reactivate') : t('registry.withdraw')}
              </button>
            </div>
          </>
        )}
      </div>
      {menu && (
        <Modal open title={`\u2068${s.fullName}\u2069`} onClose={() => setMenu(false)}>
          <div className="grid gap-2">
            <Link className="btn-secondary justify-center py-3" to={profile}>
              {t('registry.openProfile')}
            </Link>
            {!withdrawn && (
              <button
                className="btn-secondary justify-center py-3"
                onClick={() => {
                  setMenu(false);
                  onGroup();
                }}
              >
                {t('registry.addToGroup')}
              </button>
            )}
            <button
              className="btn-secondary justify-center py-3"
              onClick={() => {
                setMenu(false);
                onEdit();
              }}
            >
              {t('registry.edit')}
            </button>
            <button
              className={`btn-ghost justify-center py-3 ${withdrawn ? '' : 'text-error'}`}
              onClick={() => {
                setMenu(false);
                onStatus(withdrawn ? 'reactivate' : 'withdraw');
              }}
              disabled={busy}
            >
              {withdrawn ? t('registry.reactivate') : t('registry.withdraw')}
            </button>
          </div>
        </Modal>
      )}
    </li>
  );
}

/**
 * Registering someone who walked in. One request key per attempt: a second
 * tap, an Enter while the first is out, or a retry after a lost response all
 * reach the server as the same attempt and get the same student back.
 */
function NewStudentModal({ academyId, onClose }: { academyId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const groups = useRegistryGroups(academyId);
  const reg = useRegisterStudent(academyId);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [values, setValues] = useState<StudentFormValues>(EMPTY_STUDENT);
  const [formKey, setFormKey] = useState(0);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const dupRef = useRef<HTMLDivElement>(null);
  // The warning appears at the top of the dialog while the operator is at its
  // bottom, by the button they just pressed — bring it to them.
  useEffect(() => {
    if (!duplicates) return;
    dupRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    dupRef.current?.focus({ preventScroll: true });
  }, [duplicates]);
  const [done, setDone] = useState<RegistryStudent | null>(null);

  const send = (v: StudentFormValues, confirmDuplicate = false) => {
    if (reg.isPending) return;
    setValues(v);
    const input = {
      fullName: v.fullName,
      ...(v.gradeId ? { gradeId: v.gradeId } : {}),
      ...(v.studentPhone ? { studentPhone: v.studentPhone } : {}),
      ...(v.guardianName ? { guardianName: v.guardianName } : {}),
      ...(v.guardianPhone ? { guardianPhone: v.guardianPhone } : {}),
      ...(v.school ? { school: v.school } : {}),
      ...(v.groupId ? { groupId: v.groupId } : {}),
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    };
    reg.mutate(
      { requestKey, input },
      {
        onSuccess: (r) => {
          setDuplicates(null);
          setDone(r.student);
        },
        onError: (e) => {
          const body = (
            e as { response?: { data?: { code?: string; candidates?: DuplicateCandidate[] } } }
          ).response?.data;
          if (body?.code === 'STUDENT_POSSIBLE_DUPLICATE') setDuplicates(body.candidates ?? []);
        },
      },
    );
  };

  const another = () => {
    setDone(null);
    setDuplicates(null);
    setValues(EMPTY_STUDENT);
    setRequestKey(newRequestKey());
    setFormKey((k) => k + 1);
    reg.reset();
  };

  const isDuplicateError =
    (reg.error as { response?: { data?: { code?: string } } } | null)?.response?.data?.code ===
    'STUDENT_POSSIBLE_DUPLICATE';

  return (
    <Modal open title={done ? t('registry.doneTitle') : t('registry.new')} onClose={onClose} wide>
      {done ? (
        <div className="text-center">
          <p className="text-on-surface-variant">
            {t('registry.doneBody', { name: done.fullName })}
          </p>
          <p className="my-4 text-sm font-semibold text-on-surface-variant">
            {t('registry.codeIs')}
          </p>
          <p
            className="mx-auto mb-6 w-fit rounded-2xl bg-primary-fixed px-6 py-3 font-mono text-4xl font-bold tracking-[0.2em] text-on-primary-fixed tabular-nums"
            dir="ltr"
          >
            {done.code}
          </p>
          {done.groups.length > 0 && (
            <p className="mb-6 text-sm text-on-surface-variant">
              {t('registry.doneGroup', { name: done.groups.map((g) => g.name).join('، ') })}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button className="btn-primary px-5 py-2.5" onClick={another} autoFocus>
              {t('registry.another')}
            </button>
            <Link
              className="btn-secondary px-5 py-2.5"
              to={`/staff/students/${done.studentId}?academy=${academyId}`}
            >
              {t('registry.openProfile')}
            </Link>
            <button className="btn-ghost px-5 py-2.5" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {duplicates && (
            <div
              ref={dupRef}
              tabIndex={-1}
              role="alert"
              className="mb-4 scroll-mt-2 rounded-2xl border border-amber-600/20 bg-amber-50 p-4 text-amber-900 outline-none"
            >
              <p className="mb-2 font-bold">{t('registry.dupTitle')}</p>
              <p className="mb-3 text-sm">{t('registry.dupBody')}</p>
              <ul className="mb-3 grid gap-1.5">
                {duplicates.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono font-bold tabular-nums" dir="ltr">
                      {d.code}
                    </span>
                    <bdi className="font-semibold">{d.fullName}</bdi>
                    {d.grade && <span>· {d.grade}</span>}
                    {d.status === 'WITHDRAWN' && (
                      <Badge tone="warn">{t('registry.status.WITHDRAWN')}</Badge>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>
                  {t('registry.dupSame')}
                </button>
                <button
                  className="btn-ghost px-4 py-2 text-sm"
                  onClick={() => send(values, true)}
                  disabled={reg.isPending}
                >
                  {t('registry.dupDifferent')}
                </button>
              </div>
            </div>
          )}
          <StudentForm
            key={formKey}
            initial={values}
            groups={groups.data ?? []}
            pending={reg.isPending}
            error={isDuplicateError ? null : reg.error}
            submitLabel={t('registry.register')}
            onSubmit={(v) => send(v)}
          />
        </>
      )}
    </Modal>
  );
}

function EditStudentModal({
  academyId,
  student,
  onClose,
}: {
  academyId: string;
  student: RegistryStudent;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const upd = useUpdateStudent(academyId);
  const initial: StudentFormValues = {
    fullName: student.fullName,
    gradeId: student.grade?.id ?? '',
    studentPhone: localPhone(student.studentPhone).replace(/ /g, ''),
    guardianName: student.guardianName ?? '',
    guardianPhone: localPhone(student.guardianPhone).replace(/ /g, ''),
    school: student.school ?? '',
    groupId: '',
  };
  return (
    <Modal open title={t('registry.editTitle', { code: student.code })} onClose={onClose} wide>
      <StudentForm
        initial={initial}
        pending={upd.isPending}
        error={upd.error}
        submitLabel={t('common.save')}
        onSubmit={(v) =>
          upd.mutate(
            {
              id: student.id,
              patch: {
                fullName: v.fullName,
                gradeId: v.gradeId || null,
                studentPhone: v.studentPhone || null,
                guardianName: v.guardianName || null,
                guardianPhone: v.guardianPhone || null,
                school: v.school || null,
              },
            },
            { onSuccess: onClose },
          )
        }
      />
    </Modal>
  );
}

function AddToGroupModal({
  academyId,
  student,
  onClose,
}: {
  academyId: string;
  student: RegistryStudent;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const groups = useRegistryGroups(academyId);
  const add = useAddStudentToGroup(academyId);
  const push = useToastStore((s) => s.push);
  const [groupId, setGroupId] = useState('');
  const selectRef = useRef<HTMLSelectElement>(null);
  const already = new Set(student.groups.map((g) => g.id));
  const options = (groups.data ?? []).filter((g) => !already.has(g.id));
  return (
    <Modal open title={t('registry.addToGroupTitle', { name: student.fullName })} onClose={onClose}>
      {groups.isLoading ? (
        <Skeleton className="h-12 rounded-xl" />
      ) : !options.length ? (
        <EmptyState
          icon="diversity_3"
          title={t('registry.noGroupsToAdd')}
          hint={t('registry.noGroupsToAddHint')}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!groupId || add.isPending) return;
            add.mutate(
              { id: student.id, groupId },
              {
                onSuccess: (r) => {
                  if (r.added) {
                    push({
                      tone: 'success',
                      message: t('registry.addedToGroup', {
                        name: student.fullName,
                        group: options.find((g) => g.id === groupId)?.name ?? '',
                      }),
                    });
                  }
                  onClose();
                },
              },
            );
          }}
        >
          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
              {t('registry.form.group')}
            </span>
            <select
              ref={selectRef}
              className="input"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              autoFocus
              required
            >
              <option value="">{t('registry.pickGroup')}</option>
              {options.map((g) => (
                <option key={g.id} value={g.id}>
                  {t('registry.groupOption', { name: g.name, count: g.members })}
                </option>
              ))}
            </select>
          </label>
          <ErrorNote error={add.error} />
          <button
            type="submit"
            className="btn-primary mt-2 w-full py-3"
            disabled={!groupId || add.isPending}
            aria-busy={add.isPending}
          >
            {add.isPending ? t('registry.saving') : t('registry.addToGroup')}
          </button>
        </form>
      )}
    </Modal>
  );
}

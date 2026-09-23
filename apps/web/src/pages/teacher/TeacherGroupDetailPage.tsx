import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import {
  AttendanceStudent,
  useAddGroupMembers,
  useAttendanceSession,
  useGroupDetail,
  useMarkAttendance,
  useRemoveGroupMember,
  useRoster,
  useUnassignStaff,
  useUpdateGroup,
} from '../../lib/academyOps';
import { Badge, EmptyState, ErrorNote, Modal, Skeleton } from '../../components/ui';
import { askConfirm } from '../../lib/confirm';

const TABS = ['students', 'staff', 'attendance'] as const;
type Tab = (typeof TABS)[number];

// Literal, greppable class strings — Tailwind's JIT scanner can't see classes
// assembled at runtime via template interpolation. Same token set as Badge's
// own tone map, so status colors match the rest of the product.
const STATUS_ACTIVE_CLASS: Record<string, string> = {
  PRESENT: 'bg-primary text-on-primary',
  LATE: 'bg-amber-500 text-white',
  ABSENT: 'bg-error text-on-error',
  EXCUSED: 'bg-surface-container-high text-on-surface',
};

/** The same four colours as a dot, for the tally and the row's own marker. */
const STATUS_DOT_CLASS: Record<string, string> = {
  PRESENT: 'bg-primary',
  LATE: 'bg-amber-500',
  ABSENT: 'bg-error',
  EXCUSED: 'bg-outline',
};

function StudentsTab({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const { data } = useGroupDetail(groupId);
  const removeMember = useRemoveGroupMember(groupId);
  const addMembers = useAddGroupMembers(groupId);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const { data: roster } = useRoster({ search, page: 1, pageSize: 20 });
  const memberIds = useMemo(() => new Set(data?.members.map((m) => m.studentId)), [data]);
  const candidates = (roster?.students ?? []).filter((s) => !memberIds.has(s.id));

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button className="btn-secondary px-4 py-2 text-sm" onClick={() => setShowAdd(true)}>
          <span className="material-symbols-outlined align-middle text-lg">person_add</span>{' '}
          {t('groups.addStudents')}
        </button>
      </div>
      {!data?.members.length ? (
        <EmptyState icon="groups" title={t('groups.noMembers')} />
      ) : (
        <div className="grid gap-3">
          {data.members.map((m) => (
            <div key={m.membershipId} className="card flex items-center gap-4 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {m.avatarUrl ? (
                  <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  m.fullName?.trim()?.charAt(0)
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{m.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">
                  {m.email}
                </p>
              </div>
              <button
                className="rounded-lg border border-error/40 px-3 py-1.5 text-sm font-bold text-error hover:bg-error-container/40"
                onClick={() => removeMember.mutate(m.studentId)}
                disabled={removeMember.isPending}
              >
                {t('groups.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={t('groups.addStudents')}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('groups.rosterSearch')}
          className="mb-4 w-full rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary"
        />
        <div className="grid max-h-80 gap-2 overflow-y-auto">
          {candidates.map((s) => (
            <button
              key={s.id}
              className="flex items-center gap-3 rounded-xl border border-outline-variant p-3 text-start hover:bg-surface-container-low"
              disabled={addMembers.isPending}
              onClick={() => addMembers.mutate([s.id])}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">
                {s.fullName?.trim()?.charAt(0)}
              </span>
              <span className="min-w-0 flex-1 truncate">{s.fullName}</span>
              <span className="material-symbols-outlined text-primary">add_circle</span>
            </button>
          ))}
          {!candidates.length && (
            <p className="p-4 text-center text-sm text-on-surface-variant">
              {t('groups.noCandidates')}
            </p>
          )}
        </div>
        <ErrorNote error={addMembers.error} />
      </Modal>
    </div>
  );
}

function StaffTab({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const { data } = useGroupDetail(groupId);
  const unassign = useUnassignStaff(groupId);

  return (
    <div>
      {!data?.assignments.length ? (
        <EmptyState icon="badge" title={t('groups.noStaff')} />
      ) : (
        <div className="grid gap-3">
          {data.assignments.map((a) => (
            <div key={a.assignmentId} className="card flex items-center gap-4 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {a.avatarUrl ? (
                  <img src={a.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  a.fullName?.trim()?.charAt(0)
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{a.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">
                  {a.email}
                </p>
              </div>
              <Badge tone={a.role === 'TEACHER' ? 'primary' : 'neutral'}>
                {t(`groups.staffRole.${a.role}`)}
              </Badge>
              <button
                className="rounded-lg border border-error/40 px-3 py-1.5 text-sm font-bold text-error hover:bg-error-container/40"
                onClick={() => unassign.mutate(a.userId)}
                disabled={unassign.isPending}
              >
                {t('groups.remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Assigning a new staff member requires the academy owner and an
          existing-staff userId — deliberately no free-text add here; see
          GroupsService.assignStaff for why. */}
      <p className="mt-4 text-sm text-on-surface-variant">{t('groups.assignHint')}</p>
      <ErrorNote error={unassign.error} />
    </div>
  );
}

type Status = NonNullable<AttendanceStudent['status']>;
const STATUSES: Status[] = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'];

const today = () => new Date().toISOString().slice(0, 10);

/** `date` shifted by whole days, still as YYYY-MM-DD. Built through UTC so it
 *  cannot land on the previous day in a timezone behind the line. */
function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Taking attendance, as marking the exceptions.
 *
 * The screen used to ask for one deliberate tap per student and then a second
 * deliberate press to save: a class of thirty cost thirty-one actions on a day
 * when twenty-nine of them were simply there, and forgetting the save lost the
 * lot. Three things changed and the rest of the flow is untouched:
 *
 *  - a date nobody has marked yet opens with everyone PRESENT, so the work is
 *    the two who weren't. It is a draft, not a record — nothing is written
 *    until Save, and a date that already has a session still loads exactly what
 *    was recorded;
 *  - the row itself cycles present → late → absent → excused, so the common
 *    correction is one tap on a big target instead of aiming at a chip;
 *  - the counts and the unsaved state are on screen, and moving to another date
 *    with unsaved edits asks first, because that was the other way a teacher's
 *    work disappeared.
 */
function AttendanceTab({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [date, setDate] = useState(today);
  const { data, isLoading } = useAttendanceSession(groupId, date);
  const mark = useMarkAttendance(groupId);
  const [draft, setDraft] = useState<Record<string, Status>>({});
  /** What the server last showed, to tell an edit from an untouched default. */
  const [baseline, setBaseline] = useState<Record<string, Status>>({});

  useEffect(() => {
    if (!data) return;
    // `status: null` means "not marked on this date". Everyone starts present;
    // an already-taken date overrides that with what is actually recorded.
    const next = Object.fromEntries(
      data.students.map((s) => [s.studentId, s.status ?? 'PRESENT']),
    ) as Record<string, Status>;
    setDraft(next);
    setBaseline(
      Object.fromEntries(data.students.map((s) => [s.studentId, s.status ?? 'PRESENT'])) as Record<
        string,
        Status
      >,
    );
  }, [data]);

  const setStatus = (studentId: string, status: Status) =>
    setDraft((d) => ({ ...d, [studentId]: status }));
  /** One tap on the row moves to the next status, wrapping. */
  const cycle = (studentId: string) =>
    setDraft((d) => {
      const at = STATUSES.indexOf(d[studentId] ?? 'PRESENT');
      return { ...d, [studentId]: STATUSES[(at + 1) % STATUSES.length] };
    });
  const setAll = (status: Status) =>
    setDraft(
      (d) => Object.fromEntries(Object.keys(d).map((id) => [id, status])) as Record<string, Status>,
    );
  /** Everyone still sitting at the default becomes absent — the shape of a day
   *  where only the handful who turned up need marking. */
  const restAbsent = () =>
    setDraft(
      (d) =>
        Object.fromEntries(
          Object.entries(d).map(([id, s]) => [
            id,
            s === 'PRESENT' && baseline[id] === 'PRESENT' ? 'ABSENT' : s,
          ]),
        ) as Record<string, Status>,
    );

  const counts = STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: Object.values(draft).filter((v) => v === s).length }),
    {} as Record<Status, number>,
  );
  const taken = data?.sessionId != null;
  const dirty = Object.keys(draft).some((id) => draft[id] !== baseline[id]);
  // An untaken date is always worth saving — the roster is sitting at a default
  // nobody has recorded yet, which is exactly the thing to write down.
  const canSave = !!data?.students.length && (dirty || !taken);

  const goToDate = async (next: string) => {
    if (!next) return;
    if (dirty && !(await askConfirm(t('groups.attendance.unsavedWarning')))) return;
    setDate(next);
  };

  const save = () => {
    const records = Object.entries(draft).map(([studentId, status]) => ({ studentId, status }));
    mark.mutate({ date, records });
  };

  return (
    <div>
      {/* Which day — arrows and "today", not only a date field. Stepping back
          through last week's sessions was a calendar picker every time. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-outline-variant p-1">
          <button
            type="button"
            aria-label={t('groups.attendance.prevDay')}
            className="grid h-8 w-8 place-items-center rounded-lg hover:bg-surface-container-low"
            onClick={() => goToDate(shiftDay(date, -1))}
          >
            <span className="material-symbols-outlined text-lg rtl:rotate-180">chevron_left</span>
          </button>
          <input
            type="date"
            value={date}
            max={today()}
            onChange={(e) => goToDate(e.target.value)}
            className="bg-transparent px-2 py-1 text-sm outline-none"
          />
          <button
            type="button"
            aria-label={t('groups.attendance.nextDay')}
            disabled={date >= today()}
            className="grid h-8 w-8 place-items-center rounded-lg hover:bg-surface-container-low disabled:opacity-30"
            onClick={() => goToDate(shiftDay(date, 1))}
          >
            <span className="material-symbols-outlined text-lg rtl:rotate-180">chevron_right</span>
          </button>
        </div>
        {date !== today() && (
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-sm"
            onClick={() => goToDate(today())}
          >
            {t('groups.attendance.today')}
          </button>
        )}
        <Badge tone={taken ? 'teal' : 'neutral'}>
          {taken ? t('groups.attendance.taken') : t('groups.attendance.notTaken')}
        </Badge>
      </div>

      {!isLoading && !!data?.students.length && (
        <>
          {/* The tally, live. A teacher's own check that they marked what they meant to. */}
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface-container-low p-3">
            {STATUSES.map((s) => (
              <span key={s} className="flex items-center gap-1.5 text-sm">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT_CLASS[s]}`} />
                <span className="text-on-surface-variant">{t(`groups.status.${s}`)}</span>
                <span className="font-heading font-bold tabular-nums">{counts[s]}</span>
              </span>
            ))}
            <span className="ms-auto text-xs text-outline">
              {dirty
                ? t('groups.attendance.unsaved')
                : taken
                  ? t('groups.attendance.saved')
                  : t('groups.attendance.defaulted')}
            </span>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button className="btn-secondary px-4 py-2 text-sm" onClick={() => setAll('PRESENT')}>
              {t('groups.markAllPresent')}
            </button>
            <button className="btn-secondary px-4 py-2 text-sm" onClick={restAbsent}>
              {t('groups.attendance.restAbsent')}
            </button>
            <button
              className="btn-primary ms-auto px-5 py-2 text-sm"
              onClick={save}
              disabled={mark.isPending || !canSave}
            >
              {mark.isPending
                ? t('common.saving')
                : dirty || !taken
                  ? t('groups.attendance.save')
                  : t('groups.attendance.saved')}
            </button>
          </div>
        </>
      )}

      {isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : !data?.students.length ? (
        <EmptyState
          icon="groups"
          title={t('groups.noMembers')}
          hint={t('groups.attendance.addStudentsFirst')}
        />
      ) : (
        <div className="grid gap-2">
          {data.students.map((s) => {
            const status = draft[s.studentId] ?? 'PRESENT';
            return (
              <div key={s.studentId} className="card flex flex-wrap items-center gap-3 p-3">
                {/* The name and avatar are the big tap target: one press moves
                    this student to the next status. The chips stay for picking
                    one directly. */}
                <button
                  type="button"
                  onClick={() => cycle(s.studentId)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start transition hover:bg-surface-container-low"
                  title={t('groups.attendance.tapToCycle') as string}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">
                    {s.avatarUrl ? (
                      <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      s.fullName?.trim()?.charAt(0)
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-bold">{s.fullName}</span>
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`}
                  />
                </button>
                <div className="flex gap-1.5">
                  {STATUSES.map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatus(s.studentId, st)}
                      aria-pressed={status === st}
                      className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                        status === st
                          ? STATUS_ACTIVE_CLASS[st]
                          : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low'
                      }`}
                    >
                      {t(`groups.status.${st}`)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ErrorNote error={mark.error} />
    </div>
  );
}

export default function TeacherGroupDetailPage() {
  const { t } = useTranslation();
  const { groupId } = useParams();
  const [tab, setTab] = useState<Tab>('students');
  const { data, isLoading, error } = useGroupDetail(groupId);
  const updateGroup = useUpdateGroup(groupId ?? '');

  if (isLoading)
    return (
      <div className="page">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  if (error || !data)
    return (
      <div className="page">
        <ErrorNote error={error} />
      </div>
    );

  return (
    <div className="page">
      <Link
        to="/teacher/groups"
        className="mb-3 inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface"
      >
        <span className="material-symbols-outlined text-lg">arrow_forward</span>
        {t('groups.backToGroups')}
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-2xl font-extrabold">{data.name}</h1>
          {data.status === 'ARCHIVED' && <Badge tone="neutral">{t('groups.archived')}</Badge>}
        </div>
        <button
          className="rounded-lg border border-outline px-4 py-2 text-sm font-bold text-on-surface-variant hover:bg-surface-container-low"
          onClick={() =>
            updateGroup.mutate({ status: data.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' })
          }
          disabled={updateGroup.isPending}
        >
          {data.status === 'ACTIVE' ? t('groups.archiveGroup') : t('groups.reactivateGroup')}
        </button>
      </div>

      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setTab(tb)}
          >
            {t(`groups.detailTab.${tb}`)}
          </button>
        ))}
      </div>

      {tab === 'students' && <StudentsTab groupId={groupId!} />}
      {tab === 'staff' && <StaffTab groupId={groupId!} />}
      {tab === 'attendance' && <AttendanceTab groupId={groupId!} />}
    </div>
  );
}

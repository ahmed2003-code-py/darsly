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
          <span className="material-symbols-outlined align-middle text-lg">person_add</span> {t('groups.addStudents')}
        </button>
      </div>
      {!data?.members.length ? (
        <EmptyState icon="groups" title={t('groups.noMembers')} />
      ) : (
        <div className="grid gap-3">
          {data.members.map((m) => (
            <div key={m.membershipId} className="card flex items-center gap-4 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {m.avatarUrl ? <img src={m.avatarUrl} alt="" className="h-full w-full object-cover" /> : m.fullName?.trim()?.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{m.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">{m.email}</p>
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
          {!candidates.length && <p className="p-4 text-center text-sm text-on-surface-variant">{t('groups.noCandidates')}</p>}
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
                {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="h-full w-full object-cover" /> : a.fullName?.trim()?.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{a.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">{a.email}</p>
              </div>
              <Badge tone={a.role === 'TEACHER' ? 'primary' : 'neutral'}>{t(`groups.staffRole.${a.role}`)}</Badge>
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

function AttendanceTab({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const { data, isLoading } = useAttendanceSession(groupId, date);
  const mark = useMarkAttendance(groupId);
  const [draft, setDraft] = useState<Record<string, AttendanceStudent['status']>>({});

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.students.map((s) => [s.studentId, s.status])));
  }, [data]);

  const setStatus = (studentId: string, status: AttendanceStudent['status']) =>
    setDraft((d) => ({ ...d, [studentId]: status }));
  const markAllPresent = () => setDraft((d) => Object.fromEntries(Object.keys(d).map((id) => [id, 'PRESENT'])));

  const save = () => {
    const records = Object.entries(draft)
      .filter(([, status]) => status !== null)
      .map(([studentId, status]) => ({ studentId, status: status as string }));
    mark.mutate({ date, records });
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-xl border border-outline-variant px-4 py-2 outline-none focus:border-primary"
        />
        <div className="flex gap-2">
          <button className="btn-secondary px-4 py-2 text-sm" onClick={markAllPresent} disabled={isLoading}>{t('groups.markAllPresent')}</button>
          <button className="btn-primary px-5 py-2 text-sm" onClick={save} disabled={mark.isPending}>
            {mark.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : !data?.students.length ? (
        <EmptyState icon="groups" title={t('groups.noMembers')} />
      ) : (
        <div className="grid gap-2">
          {data.students.map((s) => (
            <div key={s.studentId} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed text-sm font-bold text-on-primary-fixed">
                {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" /> : s.fullName?.trim()?.charAt(0)}
              </span>
              <span className="min-w-0 flex-1 truncate font-bold">{s.fullName}</span>
              <div className="flex gap-1.5">
                {(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'] as const).map((st) => (
                  <button
                    key={st}
                    onClick={() => setStatus(s.studentId, st)}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                      draft[s.studentId] === st ? STATUS_ACTIVE_CLASS[st] : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low'
                    }`}
                  >
                    {t(`groups.status.${st}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
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

  if (isLoading) return <div className="page"><Skeleton className="h-40 rounded-2xl" /></div>;
  if (error || !data) return <div className="page"><ErrorNote error={error} /></div>;

  return (
    <div className="page">
      <Link to="/teacher/groups" className="mb-3 inline-flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface">
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
          onClick={() => updateGroup.mutate({ status: data.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' })}
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
              tab === tb ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
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

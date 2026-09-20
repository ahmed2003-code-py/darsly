import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { dateShort } from '../../lib/format';
import { api } from '../../lib/api';
import { useCreateGroup, useGroups, useNeedsAttention, useRoster } from '../../lib/academyOps';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, EmptyState, ErrorNote, Modal, PageHeader, Skeleton } from '../../components/ui';

const TABS = ['groups', 'roster', 'attention'] as const;
type Tab = (typeof TABS)[number];

/** A teacher picks a group's students from their own real roster (whoever is
 *  already enrolled with them, in any course) — never a bare description
 *  field standing in for the thing that actually matters. */
function StudentPicker({ selected, onToggle }: { selected: Set<string>; onToggle: (id: string) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const { data, isLoading } = useRoster({ search, pageSize: 50 });

  return (
    <div>
      <div className="relative mb-3">
        <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 text-lg text-outline">search</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('groups.rosterSearch') as string}
          className="w-full rounded-full border border-outline-variant bg-surface-container-lowest py-2 ps-10 pe-4 text-sm outline-none focus:border-primary"
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-outline-variant/50">
        {isLoading ? (
          <div className="p-4"><Skeleton className="h-32 rounded-lg" /></div>
        ) : !data?.students.length ? (
          <p className="p-6 text-center text-sm text-on-surface-variant">{t('groups.noCandidates')}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/40">
            {data.students.map((s) => {
              const checked = selected.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onToggle(s.id)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-start transition hover:bg-surface-container-low ${checked ? 'bg-primary-fixed/40' : ''}`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading text-sm font-bold text-on-primary-fixed">
                      {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" /> : s.fullName?.trim()?.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{s.fullName}</p>
                      <p className="truncate text-xs text-outline" dir="ltr">{s.email}</p>
                    </span>
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${checked ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant'}`}
                    >
                      {checked && <span className="material-symbols-outlined text-sm">check</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-2 text-xs text-outline">{t('groups.pickerHint', { count: selected.size })}</p>
    </div>
  );
}

function GroupsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useGroups({ page, pageSize: 20 });
  const createGroup = useCreateGroup();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addError, setAddError] = useState<unknown>(null);

  const toggleStudent = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const resetForm = () => { setName(''); setSelected(new Set()); setAddError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setAddError(null);
    try {
      const group = await createGroup.mutateAsync({ name: name.trim() });
      if (selected.size) {
        await api.post(`/teacher/groups/${group.id}/members`, { studentIds: [...selected] });
      }
      qc.invalidateQueries({ queryKey: ['teacher-groups'] });
      setShowCreate(false);
      resetForm();
    } catch (err) {
      // The group itself may already be created even if adding members
      // failed — never silently lose that, just surface the real error and
      // let them retry adding members from the group's own page.
      setAddError(err);
    }
  };

  if (isLoading) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setShowCreate(true)}>
          <span className="material-symbols-outlined align-middle text-lg">add</span> {t('groups.create')}
        </button>
      </div>

      {!data?.groups.length ? (
        <EmptyState icon="groups" title={t('groups.empty')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.groups.map((g) => (
            <Link key={g.id} to={`/teacher/groups/${g.id}`} className="card card-hover flex flex-col p-5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <p className="font-heading font-bold">{g.name}</p>
                {g.status === 'ARCHIVED' && <Badge tone="neutral">{t('groups.archived')}</Badge>}
              </div>
              {g.description && <p className="mb-3 line-clamp-2 text-sm text-on-surface-variant">{g.description}</p>}
              <div className="mt-auto flex items-center justify-between border-t border-outline-variant/50 pt-3 text-sm">
                <span className="text-on-surface-variant">{t('groups.studentsCount', { count: g.studentsCount })}</span>
                <span className="text-outline">{g.staff.map((s) => s.name).join(', ') || t('groups.noStaff')}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {data && data.total > data.pageSize && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <button className="btn-secondary px-4 py-2 text-sm disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.prev')}</button>
          <span className="text-sm text-on-surface-variant tabular-nums">{page} / {Math.ceil(data.total / data.pageSize)}</span>
          <button className="btn-secondary px-4 py-2 text-sm disabled:opacity-40" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>{t('common.next')}</button>
        </div>
      )}

      <Modal open={showCreate} onClose={() => { setShowCreate(false); resetForm(); }} title={t('groups.create')} wide>
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-1.5">
            <span className="text-sm font-bold">{t('groups.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl border border-outline-variant px-4 py-2.5 outline-none focus:border-primary" required autoFocus />
          </label>
          <div>
            <span className="mb-1.5 block text-sm font-bold">{t('groups.pickStudents')}</span>
            <StudentPicker selected={selected} onToggle={toggleStudent} />
          </div>
          <button type="submit" className="btn-primary py-2.5" disabled={createGroup.isPending || !name.trim()}>
            {createGroup.isPending ? t('common.saving') : t('common.save')}
          </button>
          <ErrorNote error={createGroup.error ?? addError} />
        </form>
      </Modal>
    </div>
  );
}

function RosterTab() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useRoster({ search, page, pageSize: 20 });

  return (
    <div>
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 text-xl text-outline">search</span>
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={t('groups.rosterSearch')}
          className="w-full max-w-sm rounded-full border border-outline-variant bg-surface-container-lowest py-2.5 ps-11 pe-4 text-sm outline-none focus:border-primary"
        />
      </div>
      {isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : !data?.students.length ? (
        <EmptyState icon="school" title={t('groups.rosterEmpty')} />
      ) : (
        <div className="grid gap-3">
          {data.students.map((s) => (
            <div key={s.id} className="card flex flex-wrap items-center gap-4 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
                {s.avatarUrl ? <img src={s.avatarUrl} alt="" className="h-full w-full object-cover" /> : s.fullName?.trim()?.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-heading font-bold">{s.fullName}</p>
                <p className="truncate text-xs text-outline" dir="ltr">{s.email}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.groups.map((g) => <Badge key={g.id} tone="neutral">{g.name}</Badge>)}
              </div>
              <Badge tone={s.isActive ? 'teal' : 'neutral'}>{s.isActive ? t('groups.active') : t('groups.inactive')}</Badge>
              <span className="text-xs text-outline">{s.lastActivityAt ? t('groups.lastActive', { date: dateShort(s.lastActivityAt) }) : t('groups.noActivityYet')}</span>
            </div>
          ))}
        </div>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <button className="btn-secondary px-4 py-2 text-sm disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.prev')}</button>
          <span className="text-sm text-on-surface-variant tabular-nums">{page} / {Math.ceil(data.total / data.pageSize)}</span>
          <button className="btn-secondary px-4 py-2 text-sm disabled:opacity-40" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>{t('common.next')}</button>
        </div>
      )}
    </div>
  );
}

function AttentionTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useNeedsAttention();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  const nothing = !data?.repeatedAbsences.length && !data?.inactiveStudents.length && !data?.staleGroups.length;
  if (nothing) return <EmptyState icon="task_alt" title={t('groups.attentionEmpty')} />;

  return (
    <div className="grid gap-6">
      {!!data?.repeatedAbsences.length && (
        <section>
          <h3 className="mb-3 font-heading font-bold text-error">{t('groups.repeatedAbsences')}</h3>
          <div className="grid gap-2">
            {data.repeatedAbsences.map((r) => (
              <div key={`${r.studentId}-${r.groupId}`} className="card flex items-center justify-between p-4">
                <span className="font-bold">{r.fullName}</span>
                <span className="text-sm text-on-surface-variant">{r.groupName}</span>
                <Badge tone="error">{t('groups.absentStreak', { count: r.streak })}</Badge>
              </div>
            ))}
          </div>
        </section>
      )}
      {!!data?.inactiveStudents.length && (
        <section>
          <h3 className="mb-3 font-heading font-bold text-warn">{t('groups.inactiveStudents')}</h3>
          <div className="grid gap-2">
            {data.inactiveStudents.map((s) => (
              <div key={s.studentId} className="card flex items-center justify-between p-4">
                <span className="font-bold">{s.fullName}</span>
                <span className="text-sm text-on-surface-variant">{s.lastActivityAt ? dateShort(s.lastActivityAt) : t('groups.noActivityYet')}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {!!data?.staleGroups.length && (
        <section>
          <h3 className="mb-3 font-heading font-bold text-on-surface-variant">{t('groups.staleGroups')}</h3>
          <div className="grid gap-2">
            {data.staleGroups.map((g) => (
              <Link key={g.groupId} to={`/teacher/groups/${g.groupId}`} className="card card-hover flex items-center justify-between p-4">
                <span className="font-bold">{g.name}</span>
                <span className="text-sm text-on-surface-variant">{g.lastSessionAt ? dateShort(g.lastSessionAt) : t('groups.neverTaken')}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function TeacherGroupsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'groups';

  return (
    <div className="page">
      <PageHeader title={t('groups.title')} subtitle={t('groups.subtitle')} />
      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setParams(tb === 'groups' ? {} : { tab: tb })}
          >
            {t(`groups.tab.${tb}`)}
          </button>
        ))}
      </div>
      {tab === 'groups' && <GroupsTab />}
      {tab === 'roster' && <RosterTab />}
      {tab === 'attention' && <AttentionTab />}
    </div>
  );
}

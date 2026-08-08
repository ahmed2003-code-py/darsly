import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, PageHeader, Spinner } from '../../components/ui';

const TABS = ['PENDING_APPROVAL', 'ACTIVE', 'ALL'] as const;
const SORTS = ['recent', 'name', 'spend'] as const;

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  ACTIVE: 'teal',
  PENDING_APPROVAL: 'warn',
  REJECTED: 'error',
  REVOKED: 'error',
  EXPIRED: 'neutral',
};

interface Enrollment {
  id: string;
  status: string;
  createdAt: string;
  course: { id: string; title: string; priceCents: number; pricingModel?: string };
  student: {
    id: string;
    user: { fullName: string; phone: string | null; avatarUrl: string | null };
    grade?: { nameAr?: string; nameEn?: string } | null;
  };
  payments?: { amountCents: number; status: string }[];
}

/** One student, with everything they have bought from this academy. */
interface StudentGroup {
  studentId: string;
  name: string;
  phone: string | null;
  avatarUrl: string | null;
  enrollments: Enrollment[];
  activeCount: number;
  pendingCount: number;
  paidCents: number;
  lastEnrolledAt: number;
}

/** What a student actually paid, which is not the list price after a coupon. */
function paidCents(enrollment: Enrollment): number {
  const settled = enrollment.payments?.find((p) => p.status === 'PAID');
  return settled?.amountCents ?? 0;
}

/**
 * Groups enrollments by student.
 *
 * The flat list repeated the same person once per course, so a teacher with
 * thirty students across four courses read a hundred and twenty near-identical
 * rows and could not answer "what has this student bought?" — the one question
 * the page exists to answer.
 */
function groupByStudent(rows: Enrollment[]): StudentGroup[] {
  const groups = new Map<string, StudentGroup>();
  for (const row of rows) {
    const id = row.student?.id ?? row.student?.user?.fullName ?? row.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        studentId: id,
        name: row.student?.user?.fullName ?? '—',
        phone: row.student?.user?.phone ?? null,
        avatarUrl: row.student?.user?.avatarUrl ?? null,
        enrollments: [],
        activeCount: 0,
        pendingCount: 0,
        paidCents: 0,
        lastEnrolledAt: 0,
      };
      groups.set(id, group);
    }
    group.enrollments.push(row);
    if (row.status === 'ACTIVE') group.activeCount++;
    if (row.status === 'PENDING_APPROVAL') group.pendingCount++;
    group.paidCents += paidCents(row);
    group.lastEnrolledAt = Math.max(group.lastEnrolledAt, new Date(row.createdAt).getTime());
  }
  for (const group of groups.values()) {
    group.enrollments.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }
  return [...groups.values()];
}

export default function TeacherEnrollmentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('recent');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { data, isLoading, error } = useQuery<Enrollment[]>({
    queryKey: ['teacher-enrollments', tab],
    queryFn: async () =>
      (await api.get('/teacher/enrollments', { params: tab === 'ALL' ? {} : { status: tab } })).data,
  });

  const act = useMutation({
    mutationFn: async ({ id }: { id: string }) =>
      (await api.patch(`/teacher/enrollments/${id}/revoke`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teacher-enrollments'] }),
  });

  const groups = useMemo(() => {
    const all = groupByStudent(data ?? []);
    // Match on name or phone: a teacher looking someone up has one or the other.
    const q = search.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (g) =>
            g.name.toLowerCase().includes(q) || (g.phone ?? '').replace(/\s/g, '').includes(q),
        )
      : all;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'spend') sorted.sort((a, b) => b.paidCents - a.paidCents);
    else sorted.sort((a, b) => b.lastEnrolledAt - a.lastEnrolledAt);
    return sorted;
  }, [data, search, sort]);

  const totalPaid = groups.reduce((sum, g) => sum + g.paidCents, 0);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('teacher.students.title')} subtitle={t('teacher.students.subtitle')} />

      {/* Status filter, search and sort on one line — a teacher scanning for one
          person should not have to scroll to find the box. */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {TABS.map((value) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                tab === value
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
              }`}
            >
              {t(`teacher.students.tabs.${value}`)}
            </button>
          ))}
        </div>

        <div className="relative min-w-[16rem] flex-1">
          <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-3 my-auto h-fit text-outline">
            search
          </span>
          <input
            className="input w-full ps-11"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('teacher.students.search')}
            aria-label={t('teacher.students.search')}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          {t('teacher.students.sortBy')}
          <select
            className="input py-2"
            value={sort}
            onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])}
          >
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {t(`teacher.students.sort${value[0].toUpperCase()}${value.slice(1)}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ErrorNote error={error} />

      {isLoading ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="group"
          title={search ? t('teacher.students.noMatch') : t('teacher.students.empty')}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-on-surface-variant">
            <span>
              <strong className="text-on-surface">{groups.length}</strong>{' '}
              {t('teacher.students.students')}
            </span>
            <span>
              {t('teacher.students.totalPaid')}:{' '}
              <strong className="text-on-surface">{egp(totalPaid)}</strong>
            </span>
          </div>

          <div className="grid gap-3">
            {groups.map((group) => {
              const expanded = !!open[group.studentId];
              return (
                <div
                  key={group.studentId}
                  className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low transition hover:border-primary/40"
                >
                  <button
                    onClick={() => setOpen((o) => ({ ...o, [group.studentId]: !expanded }))}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-4 p-4 text-start"
                  >
                    <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading text-lg font-bold text-primary">
                      {group.avatarUrl ? (
                        <img src={group.avatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (group.name.trim().charAt(0) || '?')
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{group.name}</span>
                      <span className="block font-mono text-xs text-outline" dir="ltr">
                        {group.phone || t('teacher.students.noPhone')}
                      </span>
                    </span>

                    <span className="hidden shrink-0 flex-wrap items-center gap-2 sm:flex">
                      {group.activeCount > 0 && (
                        <Badge tone="teal">
                          {t('teacher.students.activeCount', { count: group.activeCount })}
                        </Badge>
                      )}
                      {group.pendingCount > 0 && (
                        <Badge tone="warn">
                          {t('teacher.students.pendingCount', { count: group.pendingCount })}
                        </Badge>
                      )}
                    </span>

                    <span className="shrink-0 text-end">
                      <span className="block text-sm font-bold">{egp(group.paidCents)}</span>
                      <span className="block text-xs text-outline">
                        {t('teacher.students.courseCount', { count: group.enrollments.length })}
                      </span>
                    </span>

                    <span
                      className="material-symbols-outlined shrink-0 text-outline transition"
                      style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                    >
                      expand_more
                    </span>
                  </button>

                  {expanded && (
                    <div className="border-t border-outline-variant bg-surface">
                      {group.enrollments.map((e) => (
                        <div
                          key={e.id}
                          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-outline-variant/60 px-4 py-3 last:border-0"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{e.course.title}</span>
                            <span className="block text-xs text-outline">
                              {t('teacher.students.colDate')}: {dateShort(e.createdAt)}
                            </span>
                          </span>
                          <span className="text-sm font-bold">
                            {egp(paidCents(e) || e.course.priceCents)}
                          </span>
                          <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>
                            {t(`teacher.students.status.${e.status}`, e.status)}
                          </Badge>
                          {e.status === 'PENDING_APPROVAL' && (
                            // Read-only. Activation follows the transfer itself — the
                            // listener confirms it against the wallet SMS, and only a
                            // platform admin resolves what cannot be matched. A teacher
                            // approving their own incoming payment is the control we
                            // deliberately removed.
                            <span className="rounded-lg bg-surface-container-high px-3 py-1.5 text-xs font-semibold text-on-surface-variant">
                              {t('teacher.students.awaitingTransfer')}
                            </span>
                          )}
                          {e.status === 'ACTIVE' && (
                            <button
                              className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error transition hover:bg-error-container/40"
                              disabled={act.isPending}
                              onClick={() => {
                                if (confirm(t('teacher.students.revokeConfirm'))) {
                                  act.mutate({ id: e.id });
                                }
                              }}
                            >
                              {t('teacher.students.revoke')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, EmptyState, ErrorNote, PageHeader, Spinner } from '../../components/ui';

const TABS = ['ALL', 'PENDING_APPROVAL', 'ACTIVE'] as const;
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

/** A compact figure + its label, for the strip above the list. */
function SummaryChip({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2.5 rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2">
      <span className="material-symbols-outlined text-[20px] text-primary">{icon}</span>
      <span className="leading-tight">
        <strong className="block font-heading text-base font-bold tabular-nums">{value}</strong>
        <span className="block text-xs text-outline">{label}</span>
      </span>
    </span>
  );
}

/**
 * Reach a student in one tap.
 *
 * A private tutor's follow-up happens on WhatsApp or the phone, not in the
 * console — the number was already printed here, so the teacher was copying it
 * by hand into another app.
 */
function ContactLink({
  href,
  icon,
  label,
  external,
}: {
  href: string;
  icon: string;
  label: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="grid h-9 w-9 place-items-center rounded-full text-outline transition hover:bg-primary-fixed hover:text-primary"
    >
      <span className="material-symbols-outlined text-[20px]">{icon}</span>
    </a>
  );
}

export default function TeacherEnrollmentsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('recent');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // One request for everything, filtered locally. Querying per tab meant the
  // pending count was unknowable from any other tab — so the badge that tells a
  // teacher someone is waiting could never be shown where it matters.
  const { data, isLoading, error } = useQuery<Enrollment[]>({
    queryKey: ['teacher-enrollments'],
    queryFn: async () => (await api.get('/teacher/enrollments')).data,
  });

  const all = data ?? [];

  // People, not rows. These chips sit directly above a list that groups by
  // student and reports "2 students" — counting enrolments here put two
  // contradictory numbers on the same screen, and the tab was the one a teacher
  // reads first.
  const studentsWhere = (predicate: (e: Enrollment) => boolean) =>
    new Set(all.filter(predicate).map((e) => e.student?.id)).size;
  const counts = {
    ALL: studentsWhere(() => true),
    PENDING_APPROVAL: studentsWhere((e) => e.status === 'PENDING_APPROVAL'),
    ACTIVE: studentsWhere((e) => e.status === 'ACTIVE'),
  };

  const act = useMutation({
    mutationFn: async ({ id }: { id: string }) =>
      (await api.patch(`/teacher/enrollments/${id}/revoke`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teacher-enrollments'] }),
  });

  const groups = useMemo(() => {
    const visible = tab === 'ALL' ? all : all.filter((e) => e.status === tab);
    const grouped = groupByStudent(visible);
    // Match on name or phone: a teacher looking someone up has one or the other.
    const q = search.trim().toLowerCase();
    const filtered = q
      ? grouped.filter(
          (g) =>
            g.name.toLowerCase().includes(q) || (g.phone ?? '').replace(/\s/g, '').includes(q),
        )
      : grouped;
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'spend') sorted.sort((a, b) => b.paidCents - a.paidCents);
    else sorted.sort((a, b) => b.lastEnrolledAt - a.lastEnrolledAt);
    return sorted;
  }, [all, tab, search, sort]);

  const totalPaid = groups.reduce((sum, g) => sum + g.paidCents, 0);
  const visibleEnrollments = groups.reduce((sum, g) => sum + g.enrollments.length, 0);
  const allExpanded = groups.length > 0 && groups.every((g) => open[g.studentId]);

  const toggleAll = () =>
    setOpen(allExpanded ? {} : Object.fromEntries(groups.map((g) => [g.studentId, true])));

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('teacher.students.title')} subtitle={t('teacher.students.subtitle')} />

      {/* One toolbar: filters on top, search and sort beneath. The pending tab
          carries a live count so a teacher never has to go looking for it. */}
      <div className="mb-6 rounded-2xl border border-outline-variant bg-surface-container-low p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((value) => {
            const selected = tab === value;
            const count = counts[value];
            const waiting = value === 'PENDING_APPROVAL' && count > 0;
            return (
              <button
                key={value}
                onClick={() => setTab(value)}
                aria-pressed={selected}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition ${
                  selected
                    ? 'bg-primary text-on-primary shadow-sm'
                    : waiting
                      ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 hover:bg-amber-100'
                      : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {t(`teacher.students.tabs.${value}`)}
                {count > 0 && (
                  <span
                    className={`grid min-w-5 place-items-center rounded-full px-1.5 text-xs font-extrabold leading-5 ${
                      selected
                        ? 'bg-on-primary/20 text-on-primary'
                        : waiting
                          ? 'bg-error text-on-error'
                          : 'bg-surface-container-highest text-on-surface-variant'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-col gap-2 border-t border-outline-variant/60 pt-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-3 my-auto h-fit text-outline">
              search
            </span>
            <input
              className="input w-full ps-11 pe-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('teacher.students.search')}
              aria-label={t('teacher.students.search')}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label={t('teacher.students.clearSearch')}
                className="absolute inset-y-0 end-2 my-auto grid h-7 w-7 place-items-center rounded-full text-outline transition hover:bg-surface-container-highest hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            )}
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base">sort</span>
            <span className="sr-only sm:not-sr-only">{t('teacher.students.sortBy')}</span>
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
          {/* Both figures at once, because they answer different questions and
              were previously one ambiguous number: how many people, and how
              many things those people bought. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <SummaryChip
              icon="group"
              value={String(groups.length)}
              label={t('teacher.students.students')}
            />
            <SummaryChip
              icon="menu_book"
              value={String(visibleEnrollments)}
              label={t('teacher.students.enrollmentsLabel')}
            />
            <SummaryChip
              icon="payments"
              value={egp(totalPaid)}
              label={t('teacher.students.totalPaid')}
            />
            <button
              onClick={toggleAll}
              className="ms-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-primary transition hover:bg-primary-fixed"
            >
              <span className="material-symbols-outlined text-base">
                {allExpanded ? 'unfold_less' : 'unfold_more'}
              </span>
              {t(allExpanded ? 'teacher.students.collapseAll' : 'teacher.students.expandAll')}
            </button>
          </div>

          <div className="grid gap-3">
            {groups.map((group) => {
              const expanded = !!open[group.studentId];
              return (
                <div
                  key={group.studentId}
                  className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-low transition hover:border-primary/40"
                >
                  {/* The contact links sit beside the disclosure button rather
                      than inside it: an anchor nested in a button is invalid,
                      and tapping "call" must not also expand the card. */}
                  <div className="flex items-center gap-2 p-4">
                    <button
                      onClick={() => setOpen((o) => ({ ...o, [group.studentId]: !expanded }))}
                      aria-expanded={expanded}
                      className="flex min-w-0 flex-1 items-center gap-4 text-start"
                    >
                      <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading text-lg font-bold text-primary">
                        {group.avatarUrl ? (
                          <img src={group.avatarUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          (group.name.trim().charAt(0) || '?')
                        )}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold">
                          <bdi>{group.name}</bdi>
                        </span>
                        {/* The monospace/LTR treatment is for digits. Applying
                            it to the "no phone" fallback made an absence look
                            like a malformed number. */}
                        {group.phone ? (
                          <span className="block font-mono text-xs text-outline" dir="ltr">
                            {group.phone}
                          </span>
                        ) : (
                          <span className="block text-xs text-outline/60">
                            {t('teacher.students.noPhone')}
                          </span>
                        )}
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
                        <span className="hidden text-xs text-outline/70 sm:block">
                          {/* `lastEnrolledAt` is epoch ms, kept that way for the sort. */}
                          {t('teacher.students.lastEnrolled')}: {dateShort(new Date(group.lastEnrolledAt))}
                        </span>
                      </span>

                    </button>

                    {group.phone && (
                      <span className="flex shrink-0 items-center gap-1">
                        <ContactLink
                          href={`https://wa.me/${group.phone.replace(/\D/g, '')}`}
                          external
                          icon="chat"
                          label={t('teacher.students.whatsapp')}
                        />
                        <ContactLink
                          href={`tel:${group.phone}`}
                          icon="call"
                          label={t('teacher.students.call')}
                        />
                      </span>
                    )}

                    {/* Its own control, placed last so the row always ends with
                        the disclosure regardless of whether the contact icons
                        are there. Labelled, because a lone chevron says nothing
                        to a screen reader. */}
                    <button
                      onClick={() => setOpen((o) => ({ ...o, [group.studentId]: !expanded }))}
                      aria-expanded={expanded}
                      aria-label={t(expanded ? 'teacher.students.collapse' : 'teacher.students.expand')}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-outline transition hover:bg-surface-container-high hover:text-on-surface"
                    >
                      <span
                        className="material-symbols-outlined transition-transform"
                        style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                      >
                        expand_more
                      </span>
                    </button>
                  </div>

                  {expanded && (
                    <div className="border-t border-outline-variant bg-surface">
                      {group.enrollments.map((e) => (
                        <div
                          key={e.id}
                          className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-outline-variant/60 px-4 py-3 last:border-0"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">
                              <bdi>{e.course.title}</bdi>
                            </span>
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

import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import { Badge, EmptyState, ErrorNote, PageHeader, Skeleton, Spinner } from '../../components/ui';
import { useAuthStore } from '../../stores/auth';
import {
  useAssistantWorkspace,
  useStaffCourses,
  useStaffMe,
  useStaffStudents,
} from '../../lib/staff';

/**
 * The assistant's home: the courses the teacher gave them and the students of
 * those courses. Nothing else in the academy appears here — the server only
 * ever returns what their membership reaches.
 */
export default function StaffHomePage() {
  const { t } = useTranslation();
  const name = useAuthStore((s) => s.user?.fullName);
  const ws = useAssistantWorkspace();
  const me = useStaffMe(ws.academyId);
  const courses = useStaffCourses(ws.academyId);
  const [courseId, setCourseId] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const canSee = !!me.data?.permissions.includes('student.view');
  const students = useStaffStudents(ws.academyId, { courseId, q: search }, canSee);
  const rows = useMemo(() => students.data?.pages.flatMap((p) => p.items) ?? [], [students.data]);

  if (ws.isLoading || me.isLoading) {
    return (
      <div className="page grid place-items-center py-24">
        <Spinner />
      </div>
    );
  }
  if (!ws.academyId) {
    return (
      <div className="page">
        <EmptyState
          icon="support_agent"
          title={t('staff.noAcademy')}
          hint={t('staff.noAcademyHint')}
        />
      </div>
    );
  }
  if (me.error) {
    return (
      <div className="page">
        <ErrorNote error={me.error} />
      </div>
    );
  }
  const info = me.data!;

  return (
    <div className="page">
      <PageHeader
        eyebrow={info.academy?.name}
        title={t('staff.hello', { name: name?.split(' ')[0] ?? '' })}
        subtitle={info.title ? t('staff.youAre', { title: info.title }) : undefined}
      />

      <section className="mb-8">
        <h2 className="mb-3 font-heading text-lg font-bold text-on-surface">
          {t('staff.myCourses')}
        </h2>
        {courses.isLoading ? (
          <Skeleton className="h-20 rounded-2xl" />
        ) : !courses.data?.length ? (
          <EmptyState icon="school" title={t('staff.noCourses')} hint={t('staff.noCoursesHint')} />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {courses.data.map((c) => {
              const active = courseId === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    disabled={!canSee}
                    onClick={() => setCourseId(active ? undefined : c.id)}
                    className={`card flex w-full items-center gap-3 p-4 text-start transition disabled:cursor-default ${
                      active
                        ? 'ring-2 ring-primary'
                        : canSee
                          ? 'hover:bg-surface-container-low'
                          : ''
                    }`}
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-primary-fixed text-on-primary-fixed">
                      <span className="material-symbols-outlined">menu_book</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <bdi className="block truncate font-bold text-on-surface">{c.title}</bdi>
                      <span className="text-sm text-on-surface-variant">
                        {t('staff.studentsCount', { count: c.students })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canSee ? (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading text-lg font-bold text-on-surface">
              {courseId
                ? t('staff.studentsOf', {
                    course: courses.data?.find((c) => c.id === courseId)?.title,
                  })
                : t('staff.myStudents')}
            </h2>
            <label className="relative w-full sm:w-72">
              <span className="material-symbols-outlined pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-[20px] text-outline [direction:inherit]">
                search
              </span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('staff.searchStudents')}
                aria-label={t('staff.searchStudents')}
                className="input ps-10"
              />
            </label>
          </div>
          {students.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-2xl" />
              ))}
            </div>
          ) : students.error ? (
            <ErrorNote error={students.error} />
          ) : !rows.length ? (
            <EmptyState
              icon="group"
              title={search ? t('staff.noMatches') : t('staff.noStudents')}
            />
          ) : (
            <ul className="card divide-y divide-outline-variant/40 p-0">
              {rows.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/staff/students/${s.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none"
                  >
                    <Avatar id={s.id} name={s.name} url={s.avatarUrl} size={40} />
                    <span className="min-w-0 flex-1">
                      <bdi className="block truncate font-medium text-on-surface">{s.name}</bdi>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {s.courses.map((c) => (
                          <Badge key={c.id} tone={c.status === 'ACTIVE' ? 'primary' : 'neutral'}>
                            {c.title}
                          </Badge>
                        ))}
                      </span>
                    </span>
                    <span className="material-symbols-outlined text-outline rtl:-scale-x-100">
                      chevron_right
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {students.hasNextPage && (
            <div className="mt-3 text-center">
              <button
                className="btn-ghost"
                disabled={students.isFetchingNextPage}
                onClick={() => void students.fetchNextPage()}
              >
                {t('staff.more')}
              </button>
            </div>
          )}
        </section>
      ) : (
        <p className="text-sm text-on-surface-variant">{t('staff.noStudentAccess')}</p>
      )}
    </div>
  );
}

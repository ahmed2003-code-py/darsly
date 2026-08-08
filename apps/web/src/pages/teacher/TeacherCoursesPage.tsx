import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { Badge, CardGridSkeleton, EmptyState, ErrorNote, Field, Modal, PageHeader } from '../../components/ui';

interface CourseForm {
  id?: string;
  title: string;
  description: string;
  subjectId: string;
  gradeId: string;
  pricingModel: string;
  priceEgp: string;
  requiresEnrollmentApproval: boolean;
}

const EMPTY_FORM: CourseForm = {
  title: '',
  description: '',
  subjectId: '',
  gradeId: '',
  pricingModel: 'ONE_TIME',
  priceEgp: '',
  requiresEnrollmentApproval: true,
};

const TABS = ['ALL', 'PUBLISHED', 'DRAFT', 'ARCHIVED'] as const;
const SORTS = ['recent', 'name', 'students', 'price'] as const;

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'neutral'> = {
  PUBLISHED: 'teal',
  DRAFT: 'warn',
  ARCHIVED: 'neutral',
};

export default function TeacherCoursesPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CourseForm | null>(null);
  const [searchParams] = useSearchParams();
  const queryFromUrl = searchParams.get('q') ?? '';
  // The TopBar search lands here as ?q=; it seeds the on-page box so a teacher can
  // refine it without going back up to the header.
  const [search, setSearch] = useState(queryFromUrl);
  const [tab, setTab] = useState<(typeof TABS)[number]>('ALL');
  const [sort, setSort] = useState<(typeof SORTS)[number]>('recent');

  // Searching from the header while already on this page changes the URL but not
  // component state, so without this the box and the results would silently
  // ignore it. Keyed on the value so a teacher's own typing is never overwritten.
  const [lastUrlQuery, setLastUrlQuery] = useState(queryFromUrl);
  if (queryFromUrl !== lastUrlQuery) {
    setLastUrlQuery(queryFromUrl);
    setSearch(queryFromUrl);
  }

  const { data: allCourses, isLoading } = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
  });
  const all: any[] = allCourses ?? [];
  const lessonCount = (c: any) =>
    (c.units ?? []).reduce((sum: number, u: any) => sum + (u._count?.lessons ?? 0), 0);

  const counts = {
    ALL: all.length,
    PUBLISHED: all.filter((c) => c.status === 'PUBLISHED').length,
    DRAFT: all.filter((c) => c.status === 'DRAFT').length,
    ARCHIVED: all.filter((c) => c.status === 'ARCHIVED').length,
  };

  const courses = useMemo(() => {
    const byTab = tab === 'ALL' ? all : all.filter((c) => c.status === tab);
    const q = search.trim().toLowerCase();
    const found = q
      ? byTab.filter(
          (c) =>
            c.title?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q),
        )
      : byTab;
    const sorted = [...found];
    if (sort === 'name') sorted.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    else if (sort === 'students')
      sorted.sort((a, b) => (b._count?.enrollments ?? 0) - (a._count?.enrollments ?? 0));
    else if (sort === 'price') sorted.sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0));
    else
      sorted.sort(
        (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
      );
    return sorted;
  }, [all, tab, search, sort]);

  const totalStudents = all.reduce((sum, c) => sum + (c._count?.enrollments ?? 0), 0);
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
  });
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['teacher-courses'] });

  const save = useMutation({
    mutationFn: async (f: CourseForm) => {
      const payload = {
        title: f.title,
        description: f.description,
        subjectId: f.subjectId || undefined,
        gradeId: f.gradeId || undefined,
        pricingModel: f.pricingModel,
        priceCents: Math.round(Number(f.priceEgp || 0) * 100),
        requiresEnrollmentApproval: f.requiresEnrollmentApproval,
      };
      return f.id
        ? (await api.patch(`/teacher/courses/${f.id}`, payload)).data
        : (await api.post('/teacher/courses', payload)).data;
    },
    onSuccess: () => {
      invalidate();
      setForm(null);
    },
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      (await api.patch(`/teacher/courses/${id}`, { status })).data,
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/teacher/courses/${id}`)).data,
    onSuccess: invalidate,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form) save.mutate(form);
  }

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title={t('teacher.courses.title')}
        subtitle={t('teacher.courses.subtitle')}
        action={
          <button className="btn-primary" onClick={() => setForm({ ...EMPTY_FORM })}>
            <span className="material-symbols-outlined">add</span>
            {t('teacher.newCourse')}
          </button>
        }
      />

      {/* Same toolbar as My students: filters with live counts, then a visible
          search box — the header search alone is easy to miss and impossible to
          refine once a teacher has more courses than fit on a screen. */}
      <div className="mb-6 rounded-2xl border border-outline-variant bg-surface-container-low p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((value) => {
            const selected = tab === value;
            const count = counts[value];
            return (
              <button
                key={value}
                onClick={() => setTab(value)}
                aria-pressed={selected}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition ${
                  selected
                    ? 'bg-primary text-on-primary shadow-sm'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {t(`teacher.courses.tabs.${value}`)}
                {count > 0 && (
                  <span
                    className={`grid min-w-5 place-items-center rounded-full px-1.5 text-xs font-extrabold leading-5 ${
                      selected
                        ? 'bg-on-primary/20 text-on-primary'
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
              placeholder={t('teacher.courses.search')}
              aria-label={t('teacher.courses.search')}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label={t('teacher.courses.clearSearch')}
                className="absolute inset-y-0 end-2 my-auto grid h-7 w-7 place-items-center rounded-full text-outline transition hover:bg-surface-container-highest hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            )}
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base">sort</span>
            <span className="sr-only sm:not-sr-only">{t('teacher.courses.sortBy')}</span>
            <select
              className="input py-2"
              value={sort}
              onChange={(e) => setSort(e.target.value as (typeof SORTS)[number])}
            >
              {SORTS.map((value) => (
                <option key={value} value={value}>
                  {t(`teacher.courses.sort${value[0].toUpperCase()}${value.slice(1)}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!isLoading && all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-on-surface-variant">
          <span className="font-semibold text-on-surface">
            {t('teacher.courses.countCourses', { count: courses.length })}
          </span>
          <span>
            {t('teacher.courses.totalStudents')}:{' '}
            <strong className="text-on-surface">{totalStudents}</strong>
          </span>
        </div>
      )}

      {isLoading ? (
        <CardGridSkeleton count={6} />
      ) : !courses?.length ? (
        <EmptyState
          icon="menu_book"
          title={search || tab !== 'ALL' ? t('teacher.courses.noMatch') : t('teacher.courses.empty')}
        />
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((c: any) => (
            <article
              key={c.id}
              className="card flex flex-col p-5 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="mb-2 flex items-center justify-between">
                <Badge tone={STATUS_TONE[c.status]}>{t(`teacher.courses.status.${c.status}`)}</Badge>
                <span className="text-xs text-outline">
                  {c.subject ? (ar ? c.subject.nameAr : c.subject.nameEn) : ''}
                  {c.grade ? ` · ${ar ? c.grade.nameAr : c.grade.nameEn}` : ''}
                </span>
              </div>
              <h3 className="mb-1 font-heading text-lg font-bold">{c.title}</h3>
              <p className="mb-4 line-clamp-2 flex-1 text-sm text-on-surface-variant">{c.description}</p>
              <div className="mb-4 flex items-center gap-4 text-sm text-on-surface-variant">
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-base">smart_display</span>
                  {t('course.lessonsCount', { count: lessonCount(c) })}
                </span>
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-base">group</span>
                  {c._count.enrollments}
                </span>
                <span className="ms-auto font-heading font-extrabold text-on-surface">
                  {egp(c.priceCents)}
                  {c.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
                    <span className="text-xs font-normal text-outline">/{t('course.perMonth')}</span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-outline-variant/50 pt-4">
                <Link to={`/teacher/courses/${c.id}`} className="btn-primary flex-1 py-2 text-center text-sm">
                  {t('teacher.courses.builder')}
                </Link>
                <button
                  className="btn-ghost px-3 py-2 text-sm"
                  title={t('teacher.courses.edit')}
                  aria-label={t('teacher.courses.edit')}
                  onClick={() =>
                    setForm({
                      id: c.id,
                      title: c.title,
                      description: c.description,
                      subjectId: c.subjectId ?? '',
                      gradeId: c.gradeId ?? '',
                      pricingModel: c.pricingModel,
                      priceEgp: String(c.priceCents / 100),
                      requiresEnrollmentApproval: c.requiresEnrollmentApproval,
                    })
                  }
                >
                  <span className="material-symbols-outlined text-base">edit</span>
                </button>
                <button
                  className="btn-ghost px-3 py-2 text-sm"
                  title={c.status === 'PUBLISHED' ? t('teacher.courses.unpublish') : t('teacher.courses.publish')}
                  aria-label={
                    c.status === 'PUBLISHED' ? t('teacher.courses.unpublish') : t('teacher.courses.publish')
                  }
                  onClick={() =>
                    setStatus.mutate({ id: c.id, status: c.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED' })
                  }
                >
                  <span className="material-symbols-outlined text-base">
                    {c.status === 'PUBLISHED' ? 'visibility_off' : 'publish'}
                  </span>
                </button>
                <button
                  className="rounded-lg border border-error/30 px-3 py-2 text-error transition hover:bg-error-container/40"
                  title={t('teacher.courses.delete')}
                  aria-label={t('teacher.courses.delete')}
                  onClick={() => window.confirm(t('teacher.courses.deleteConfirm')) && remove.mutate(c.id)}
                >
                  <span className="material-symbols-outlined text-base">delete</span>
                </button>
              </div>
              <ErrorNote error={setStatus.variables?.id === c.id ? setStatus.error : null} />
            </article>
          ))}
        </div>
      )}

      <Modal
        open={!!form}
        title={form?.id ? t('teacher.courses.editTitle') : t('teacher.courses.createTitle')}
        onClose={() => setForm(null)}
      >
        {form && (
          <form onSubmit={submit}>
            <Field label={t('teacher.courses.form.title')}>
              <input className="input" required minLength={3} value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label={t('teacher.courses.form.description')}>
              <textarea className="input min-h-24" value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('teacher.courses.form.subject')}>
                <select className="input py-2" value={form.subjectId}
                  onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
                  <option value="">{t('teacher.courses.form.none')}</option>
                  {(subjects ?? []).map((s: any) => (
                    <option key={s.id} value={s.id}>{ar ? s.nameAr : s.nameEn}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('teacher.courses.form.grade')}>
                <select className="input py-2" value={form.gradeId}
                  onChange={(e) => setForm({ ...form, gradeId: e.target.value })}>
                  <option value="">{t('teacher.courses.form.none')}</option>
                  {(grades ?? []).map((g: any) => (
                    <option key={g.id} value={g.id}>{ar ? g.nameAr : g.nameEn}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('teacher.courses.form.pricingModel')}>
                <select className="input py-2" value={form.pricingModel}
                  onChange={(e) => setForm({ ...form, pricingModel: e.target.value })}>
                  <option value="ONE_TIME">{t('teacher.courses.form.oneTime')}</option>
                  <option value="MONTHLY_SUBSCRIPTION">{t('teacher.courses.form.monthly')}</option>
                  <option value="BUNDLE">{t('teacher.courses.form.bundle')}</option>
                </select>
              </Field>
              <Field label={t('teacher.courses.form.price')}>
                <input className="input" inputMode="decimal" value={form.priceEgp}
                  onChange={(e) => setForm({ ...form, priceEgp: e.target.value.replace(/[^\d.]/g, '') })} />
              </Field>
            </div>
            <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary"
                checked={form.requiresEnrollmentApproval}
                onChange={(e) => setForm({ ...form, requiresEnrollmentApproval: e.target.checked })} />
              {t('teacher.courses.form.requiresApproval')}
            </label>
            <button className="btn-primary w-full" disabled={save.isPending}>
              {form.id ? t('teacher.courses.form.save') : t('teacher.courses.form.create')}
            </button>
            <ErrorNote error={save.error} />
          </form>
        )}
      </Modal>
    </div>
  );
}

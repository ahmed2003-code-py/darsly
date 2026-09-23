import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';
import { egp } from '../../lib/format';
import { stripMarkdown } from '../../lib/markdown';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { STAGES, type Grade } from '../../lib/stages';
import { type Subject } from '../../lib/subjects';
import {
  Badge,
  CardGridSkeleton,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
} from '../../components/ui';
import { useAuthStore } from '../../stores/auth';
import { Role } from '@darsly/shared-types';

interface CourseForm {
  id?: string;
  title: string;
  description: string;
  subjectId: string;
  gradeIds: string[];
  pricingModel: string;
  priceEgp: string;
}

const EMPTY_FORM: CourseForm = {
  title: '',
  description: '',
  subjectId: '',
  gradeIds: [],
  pricingModel: 'ONE_TIME',
  priceEgp: '',
};

const TABS = ['ALL', 'PUBLISHED', 'DRAFT', 'ARCHIVED'] as const;
const SORTS = ['recent', 'name', 'students', 'price'] as const;

const STATUS_TONE: Record<string, 'teal' | 'warn' | 'neutral'> = {
  PUBLISHED: 'teal',
  DRAFT: 'warn',
  ARCHIVED: 'neutral',
};

/** Small caps heading that separates one group of decisions from the next. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="mb-3 text-xs font-extrabold uppercase tracking-wider text-primary">
      {children}
    </h4>
  );
}

export default function TeacherCoursesPage() {
  const { t, i18n } = useTranslation();
  // A Center's desk administers; it does not teach. STAFF sees the Center's
  // whole catalogue — that is the point of the page for them — but authoring
  // belongs to the teachers whose names are on the courses, so the page drops
  // its authoring affordances rather than offering buttons the API refuses.
  const isDesk = useAuthStore((s) => s.user?.role) === Role.STAFF;
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
          (c) => c.title?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q),
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
  // The teacher's own answers from sign-up. A course is filed under the subject
  // they teach and aimed inside the stages they teach, so the form states the
  // first and offers only the second rather than reprinting the whole catalogue
  // and letting them file a course somewhere they do not work.
  const { data: profile } = useQuery({
    queryKey: ['teacher-profile'],
    queryFn: async () => (await api.get('/teacher/profile')).data,
  });
  // Everything this teacher signed up to teach — the only subjects a course of
  // theirs may be filed under, which the API checks again on the way in.
  const mySubjects: Subject[] = (profile?.subjects ?? []).map(
    (s: { subject: Subject }) => s.subject,
  );
  const myStages: string[] = profile?.stages ?? [];
  // The years inside those stages — the exact set a course may be aimed at.
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
  });
  const myYears: Grade[] = (grades ?? []).filter(
    (g: Grade) => g.stage && myStages.includes(g.stage),
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['teacher-courses'] });

  const save = useMutation({
    mutationFn: async (f: CourseForm) => {
      const payload = {
        title: f.title,
        description: f.description,
        ...(f.subjectId ? { subjectId: f.subjectId } : {}),
        gradeIds: f.gradeIds,
        pricingModel: f.pricingModel,
        priceCents: Math.round(Number(f.priceEgp || 0) * 100),
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
    <div className="page">
      <PageHeader
        title={isDesk ? t('center.courses') : t('teacher.courses.title')}
        subtitle={isDesk ? t('center.coursesOversightSub') : t('teacher.courses.subtitle')}
        action={
          isDesk ? undefined : (
            <div className="flex flex-wrap gap-2">
              {/* The second way in: a teacher whose exam is already on paper
                  does not start by making a course. */}
              <Link className="btn-secondary" to="/teacher/paper-imports">
                <span className="material-symbols-outlined">document_scanner</span>
                {t('paper.importFromPaper')}
              </Link>
              <button className="btn-primary" onClick={() => setForm({ ...EMPTY_FORM })}>
                <span className="material-symbols-outlined">add</span>
                {t('teacher.newCourse')}
              </button>
            </div>
          )
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
            // Nothing archives a course any more — delete deletes. The filter
            // stays only while a teacher still has ones archived by the old
            // behaviour, and disappears as they clear them.
            if (value === 'ARCHIVED' && count === 0 && !selected) return null;
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

          <label className="flex shrink-0 items-center gap-1.5 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base">sort</span>
            <span className="sr-only sm:not-sr-only">{t('teacher.courses.sortBy')}</span>
            {/* Narrower than a text input's `px-4`: the label already says what
                this is, so the padding was reading as a gap between the two. */}
            <select
              className="input px-3 py-2"
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
          title={
            search || tab !== 'ALL' ? t('teacher.courses.noMatch') : t('teacher.courses.empty')
          }
        />
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((c: any) => (
            <article
              key={c.id}
              className="card flex flex-col p-5 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="mb-2 flex items-center justify-between">
                <Badge tone={STATUS_TONE[c.status]}>
                  {t(`teacher.courses.status.${c.status}`)}
                </Badge>
                <span className="text-xs text-outline">
                  {c.subject ? (ar ? c.subject.nameAr : c.subject.nameEn) : ''}
                  {(c.grades ?? []).length
                    ? ` · ${c.grades.map((g: Grade) => (ar ? g.nameAr : g.nameEn)).join('، ')}`
                    : ''}
                </span>
              </div>
              <h3 className="mb-1 font-heading text-lg font-bold">{c.title}</h3>
              <p className="mb-4 line-clamp-2 flex-1 text-sm text-on-surface-variant">
                {stripMarkdown(c.description)}
              </p>
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
                    <span className="text-xs font-normal text-outline">
                      /{t('course.perMonth')}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-outline-variant/50 pt-4">
                <Link
                  to={`/teacher/courses/${c.id}`}
                  className="btn-primary flex-1 py-2 text-center text-sm"
                >
                  {c.canEdit === false
                    ? t('teacher.courses.viewContent')
                    : t('teacher.courses.builder')}
                </Link>
                {c.canEdit !== false && (
                  <button
                    className="btn-ghost px-3 py-2 text-sm"
                    title={t('teacher.courses.edit')}
                    aria-label={t('teacher.courses.edit')}
                    onClick={() =>
                      setForm({
                        id: c.id,
                        title: c.title,
                        description: c.description,
                        subjectId: c.subject?.id ?? '',
                        gradeIds: (c.grades ?? []).map((g: { id: string }) => g.id),
                        pricingModel: c.pricingModel,
                        priceEgp: String(c.priceCents / 100),
                      })
                    }
                  >
                    <span className="material-symbols-outlined text-base">edit</span>
                  </button>
                )}
                <button
                  className="btn-ghost px-3 py-2 text-sm"
                  title={
                    c.status === 'PUBLISHED'
                      ? t('teacher.courses.unpublish')
                      : t('teacher.courses.publish')
                  }
                  aria-label={
                    c.status === 'PUBLISHED'
                      ? t('teacher.courses.unpublish')
                      : t('teacher.courses.publish')
                  }
                  onClick={() =>
                    setStatus.mutate({
                      id: c.id,
                      status: c.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED',
                    })
                  }
                >
                  <span className="material-symbols-outlined text-base">
                    {c.status === 'PUBLISHED' ? 'visibility_off' : 'publish'}
                  </span>
                </button>
                {c.canEdit !== false && (
                  <button
                    className="rounded-lg border border-error/30 px-3 py-2 text-error transition hover:bg-error-container/40"
                    title={t('teacher.courses.delete')}
                    aria-label={t('teacher.courses.delete')}
                    onClick={async () => {
                      // The count is the whole point of asking: removing a course
                      // nobody joined costs nothing, and removing one with a class
                      // in it takes their access with it.
                      const enrolled = c._count?.enrollments ?? 0;
                      const ask = enrolled
                        ? t('teacher.courses.deleteConfirmWithStudents', { count: enrolled })
                        : t('teacher.courses.deleteConfirm');
                      if (await askConfirm(ask)) remove.mutate(c.id);
                    }}
                  >
                    <span className="material-symbols-outlined text-base">delete</span>
                  </button>
                )}
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
        wide
      >
        {form && (
          <form onSubmit={submit} className="grid gap-6">
            {/* Grouped into what a teacher decides together, rather than one long
                column of equal-weight inputs. */}
            <section>
              <SectionLabel>{t('teacher.courses.form.sectionBasics')}</SectionLabel>
              <Field
                label={t('teacher.courses.form.title')}
                hint={t('teacher.courses.form.titleHint')}
              >
                <div className="relative">
                  <input
                    className="input pe-16"
                    required
                    minLength={3}
                    maxLength={80}
                    autoFocus
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                  <span className="pointer-events-none absolute inset-y-0 end-3 my-auto h-fit font-mono text-xs text-outline">
                    {t('teacher.courses.form.titleCount', { n: form.title.length })}
                  </span>
                </div>
              </Field>
              <Field
                label={t('teacher.courses.form.description')}
                hint={t('teacher.courses.form.descriptionHint')}
              >
                <MarkdownEditor
                  id="course-description"
                  maxLength={600}
                  value={form.description}
                  onChange={(v) => setForm({ ...form, description: v })}
                />
              </Field>
            </section>

            <section>
              <SectionLabel>{t('teacher.courses.form.sectionClassify')}</SectionLabel>
              {/* Stated when there is nothing to decide, asked when there is:
                  a teacher who signed up for one subject has already answered
                  this, and one who takes both school systems has not. */}
              <Field label={t('teacher.courses.form.subject')}>
                {mySubjects.length > 1 ? (
                  <select
                    className="input"
                    value={form.subjectId}
                    onChange={(e) => setForm({ ...form, subjectId: e.target.value })}
                  >
                    <option value="">{t('auth.subjectPh')}</option>
                    {mySubjects.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {ar ? sub.nameAr : sub.nameEn}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 text-sm font-semibold">
                    {mySubjects[0]
                      ? ar
                        ? mySubjects[0].nameAr
                        : mySubjects[0].nameEn
                      : t('teacher.courses.form.noSubject')}
                  </p>
                )}
              </Field>

              {/* The exact years, grouped under their stage. A second-year
                  course shown to first-years is the noise this removes, so the
                  choice has to be at year level even though the teacher signed
                  up by stage. */}
              <div className="mb-4">
                <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">
                  {t('teacher.courses.form.years')}
                </span>
                {myYears.length === 0 ? (
                  <p className="rounded-xl border border-outline-variant bg-surface-container-low px-4 py-2.5 text-sm text-on-surface-variant">
                    {t('teacher.courses.form.noStages')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {STAGES.filter((st) => myYears.some((g) => g.stage === st)).map((st) => (
                      <div key={st}>
                        <span className="mb-1.5 block text-xs font-semibold text-outline">
                          {t(`stage.${st}`)}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          {myYears
                            .filter((g) => g.stage === st)
                            .map((g) => {
                              const on = form.gradeIds.includes(g.id);
                              return (
                                <button
                                  key={g.id}
                                  type="button"
                                  aria-pressed={on}
                                  onClick={() =>
                                    setForm({
                                      ...form,
                                      gradeIds: on
                                        ? form.gradeIds.filter((x) => x !== g.id)
                                        : [...form.gradeIds, g.id],
                                    })
                                  }
                                  className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                                    on
                                      ? 'border-primary bg-primary text-on-primary'
                                      : 'border-outline-variant text-on-surface-variant hover:border-outline'
                                  }`}
                                >
                                  {ar ? g.nameAr : g.nameEn}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-outline">{t('teacher.courses.form.yearsHint')}</p>
              </div>
            </section>

            <section>
              <SectionLabel>{t('teacher.courses.form.sectionPricing')}</SectionLabel>
              <div className="grid gap-x-4 sm:grid-cols-2">
                <Field label={t('teacher.courses.form.pricingModel')}>
                  <select
                    className="input py-2"
                    value={form.pricingModel}
                    onChange={(e) => setForm({ ...form, pricingModel: e.target.value })}
                  >
                    <option value="ONE_TIME">{t('teacher.courses.form.oneTime')}</option>
                    <option value="MONTHLY_SUBSCRIPTION">
                      {t('teacher.courses.form.monthly')}
                    </option>
                    <option value="BUNDLE">{t('teacher.courses.form.bundle')}</option>
                  </select>
                </Field>
                <Field
                  label={t('teacher.courses.form.price')}
                  hint={
                    form.pricingModel === 'MONTHLY_SUBSCRIPTION'
                      ? t('teacher.courses.form.priceMonthlyHint')
                      : t('teacher.courses.form.priceHint')
                  }
                >
                  <div className="relative">
                    <input
                      className="input pe-24 font-heading text-lg font-bold"
                      inputMode="decimal"
                      placeholder="0"
                      value={form.priceEgp}
                      onChange={(e) =>
                        setForm({ ...form, priceEgp: e.target.value.replace(/[^\d.]/g, '') })
                      }
                    />
                    <span className="pointer-events-none absolute inset-y-0 end-3 my-auto h-fit text-sm font-semibold text-outline">
                      {Number(form.priceEgp || 0) === 0
                        ? t('teacher.courses.form.priceFree')
                        : `${t('common.currencyShort')}${
                            form.pricingModel === 'MONTHLY_SUBSCRIPTION'
                              ? t('teacher.courses.form.perMonthSuffix')
                              : ''
                          }`}
                    </span>
                  </div>
                </Field>
              </div>
            </section>

            <ErrorNote error={save.error} />

            <div className="flex gap-3 border-t border-outline-variant pt-4">
              <button type="button" className="btn-ghost flex-1" onClick={() => setForm(null)}>
                {t('teacher.courses.form.cancel')}
              </button>
              <button
                className="btn-primary flex-[2]"
                disabled={save.isPending || !form.title.trim()}
              >
                {form.id ? t('teacher.courses.form.save') : t('teacher.courses.form.create')}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

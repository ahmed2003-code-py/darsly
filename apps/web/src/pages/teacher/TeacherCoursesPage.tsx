import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
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
  const q = (searchParams.get('q') ?? '').trim().toLowerCase(); // from the TopBar search

  const { data: allCourses, isLoading } = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
  });
  const courses = q
    ? (allCourses ?? []).filter((c: any) => c.title.toLowerCase().includes(q))
    : allCourses;
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
        subtitle={q ? t('discovery.resultsFor', { q }) : t('teacher.courses.subtitle')}
        action={
          <button className="btn-primary" onClick={() => setForm({ ...EMPTY_FORM })}>
            <span className="material-symbols-outlined">add</span>
            {t('teacher.newCourse')}
          </button>
        }
      />

      {isLoading ? (
        <CardGridSkeleton count={6} />
      ) : !courses?.length ? (
        <EmptyState icon="menu_book" title={q ? t('discovery.noResults') : t('teacher.courses.empty')} />
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((c: any) => (
            <article key={c.id} className="card flex flex-col p-5">
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
                  {t('course.lessonsCount', {
                    count: c.units.reduce((s: number, u: any) => s + u._count.lessons, 0),
                  })}
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
                  onClick={() =>
                    setStatus.mutate({ id: c.id, status: c.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED' })
                  }
                >
                  <span className="material-symbols-outlined text-base">
                    {c.status === 'PUBLISHED' ? 'visibility_off' : 'publish'}
                  </span>
                </button>
                <button
                  className="rounded-lg border border-error/30 px-3 py-2 text-error hover:bg-error-container/40"
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

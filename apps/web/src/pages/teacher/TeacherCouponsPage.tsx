import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteButton } from '../../components/DeleteButton';
import { FormEvent, useState } from 'react';
import { parseMoneyToCents } from '@darsly/shared-types';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
} from '../../components/ui';

interface CouponForm {
  code: string;
  type: 'percent' | 'amount';
  value: string;
  maxUses: string;
  expiresAt: string;
  courseId: string;
  /** What it can discount: courses (every coupon before live seats), live seats, or both. */
  scope: 'COURSE' | 'LIVE' | 'ALL';
  liveSessionId: string;
  maxUsesPerStudent: string;
}

const EMPTY: CouponForm = {
  code: '',
  type: 'percent',
  value: '',
  maxUses: '',
  expiresAt: '',
  courseId: '',
  scope: 'COURSE',
  liveSessionId: '',
  maxUsesPerStudent: '',
};

export default function TeacherCouponsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CouponForm | null>(null);

  const { data: coupons, isLoading } = useQuery({
    queryKey: ['teacher-coupons'],
    queryFn: async () => (await api.get('/teacher/coupons')).data,
  });
  const { data: courses } = useQuery({
    queryKey: ['teacher-courses'],
    queryFn: async () => (await api.get('/teacher/courses')).data,
  });
  const { data: liveSessions } = useQuery({
    queryKey: ['teacher-live'],
    queryFn: async () => (await api.get('/teacher/live')).data,
  });
  const paidSessions = (liveSessions ?? []).filter(
    (s: any) => s.accessMode === 'PAID' && s.status !== 'ENDED',
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['teacher-coupons'] });

  const create = useMutation({
    mutationFn: async (f: CouponForm) =>
      (
        await api.post('/teacher/coupons', {
          code: f.code.trim().toUpperCase(),
          percentOff: f.type === 'percent' ? Number(f.value) : undefined,
          // Read as an exact amount of piasters, never through a float.
          amountOffCents:
            f.type === 'amount' ? (parseMoneyToCents(f.value) ?? undefined) : undefined,
          maxUses: f.maxUses ? Number(f.maxUses) : undefined,
          expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : undefined,
          scope: f.scope,
          courseId: f.scope === 'COURSE' ? f.courseId || undefined : undefined,
          liveSessionId: f.scope === 'LIVE' ? f.liveSessionId || undefined : undefined,
          maxUsesPerStudent:
            f.scope !== 'COURSE' && f.maxUsesPerStudent ? Number(f.maxUsesPerStudent) : undefined,
        })
      ).data,
    onSuccess: () => {
      invalidate();
      setForm(null);
    },
  });

  const toggle = useMutation({
    mutationFn: async (c: any) =>
      (await api.patch(`/teacher/coupons/${c.id}`, { isActive: !c.isActive })).data,
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/teacher/coupons/${id}`)).data,
    onSuccess: invalidate,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form) create.mutate(form);
  }

  return (
    <div className="page">
      <PageHeader
        title={t('teacher.coupons.title')}
        subtitle={t('teacher.coupons.subtitle')}
        action={
          <button className="btn-primary" onClick={() => setForm({ ...EMPTY })}>
            <span className="material-symbols-outlined">add</span>
            {t('teacher.coupons.new')}
          </button>
        }
      />

      {isLoading ? (
        <Spinner />
      ) : !coupons?.length ? (
        <EmptyState icon="sell" title={t('teacher.coupons.empty')} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/40 text-on-surface-variant">
                <th className="px-6 py-4 text-start font-bold">{t('teacher.coupons.code')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.coupons.discount')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.coupons.course')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.coupons.uses')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('teacher.coupons.expiresAt')}</th>
                <th className="px-6 py-4 text-start font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((c: any) => (
                <tr key={c.id} className="border-b border-outline-variant/30 last:border-0">
                  <td className="px-6 py-4">
                    <span
                      className="rounded-md bg-primary-fixed px-2 py-1 font-mono font-bold text-on-primary-fixed-variant"
                      dir="ltr"
                    >
                      {c.code}
                    </span>
                  </td>
                  <td className="px-6 py-4 font-bold">
                    {c.percentOff ? `${c.percentOff}%` : egp(c.amountOffCents)}
                  </td>
                  <td className="px-6 py-4 text-on-surface-variant">
                    <span className="me-1 rounded bg-surface-container px-1.5 py-0.5 text-xs font-semibold">
                      {t(`teacher.coupons.scope.${c.scope ?? 'COURSE'}`)}
                    </span>
                    {c.course?.title ??
                      c.liveSession?.title ??
                      (c.scope === 'LIVE'
                        ? t('teacher.coupons.allLive')
                        : c.scope === 'ALL'
                          ? ''
                          : t('teacher.coupons.allCourses'))}
                  </td>
                  <td className="px-6 py-4">
                    {c.usedCount} / {c.maxUses ?? '∞'}
                  </td>
                  <td className="px-6 py-4 text-outline">
                    {c.expiresAt ? dateShort(c.expiresAt) : t('teacher.coupons.noExpiry')}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => toggle.mutate(c)}>
                        <Badge tone={c.isActive ? 'teal' : 'neutral'}>
                          {c.isActive ? t('teacher.coupons.active') : t('teacher.coupons.inactive')}
                        </Badge>
                      </button>
                      <DeleteButton
                        compact
                        name={c.code}
                        className="border-0 px-2 py-1"
                        onConfirm={() => remove.mutateAsync(c.id)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!form} title={t('teacher.coupons.new')} onClose={() => setForm(null)}>
        {form && (
          <form onSubmit={submit}>
            <Field label={t('teacher.coupons.code')}>
              <input
                className="input"
                dir="ltr"
                required
                pattern="[A-Za-z0-9_-]{3,24}"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('teacher.coupons.discountType')}>
                <select
                  className="input py-2"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as CouponForm['type'] })}
                >
                  <option value="percent">{t('teacher.coupons.percentOff')}</option>
                  <option value="amount">{t('teacher.coupons.amountOff')}</option>
                </select>
              </Field>
              <Field label={t('teacher.coupons.discount')}>
                <input
                  className="input"
                  inputMode="numeric"
                  required
                  value={form.value}
                  onChange={(e) =>
                    setForm({ ...form, value: e.target.value.replace(/[^\d.]/g, '') })
                  }
                />
              </Field>
            </div>
            <Field label={t('teacher.coupons.appliesTo')}>
              <select
                className="input py-2"
                value={form.scope}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scope: e.target.value as CouponForm['scope'],
                    courseId: '',
                    liveSessionId: '',
                  })
                }
              >
                <option value="COURSE">{t('teacher.coupons.scope.COURSE')}</option>
                <option value="LIVE">{t('teacher.coupons.scope.LIVE')}</option>
                <option value="ALL">{t('teacher.coupons.scope.ALL')}</option>
              </select>
            </Field>
            {form.scope === 'COURSE' && (
              <Field label={t('teacher.coupons.course')}>
                <select
                  className="input py-2"
                  value={form.courseId}
                  onChange={(e) => setForm({ ...form, courseId: e.target.value })}
                >
                  <option value="">{t('teacher.coupons.allCourses')}</option>
                  {(courses ?? []).map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {form.scope === 'LIVE' && (
              <Field label={t('teacher.coupons.liveSession')}>
                <select
                  className="input py-2"
                  value={form.liveSessionId}
                  onChange={(e) => setForm({ ...form, liveSessionId: e.target.value })}
                >
                  <option value="">{t('teacher.coupons.allLive')}</option>
                  {paidSessions.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {form.scope !== 'COURSE' && (
              <Field label={t('teacher.coupons.perStudent')} hint={t('teacher.coupons.unlimited')}>
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.maxUsesPerStudent}
                  onChange={(e) =>
                    setForm({ ...form, maxUsesPerStudent: e.target.value.replace(/\D/g, '') })
                  }
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('teacher.coupons.maxUses')} hint={t('teacher.coupons.unlimited')}>
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <Field label={t('teacher.coupons.expiresAt')} hint={t('teacher.coupons.noExpiry')}>
                <input
                  className="input py-2"
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                />
              </Field>
            </div>
            <button className="btn-primary w-full" disabled={create.isPending}>
              {t('teacher.coupons.create')}
            </button>
            <ErrorNote error={create.error} />
          </form>
        )}
      </Modal>
    </div>
  );
}

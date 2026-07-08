import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { dateShort, duration, egp } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { Badge, EmptyState, ErrorNote, Spinner } from '../../components/ui';

const LESSON_ICON: Record<string, string> = {
  VIDEO: 'play_circle',
  QUIZ: 'quiz',
  ASSIGNMENT: 'assignment',
};

/** Course page per course_curriculum design: curriculum accordion with
 *  lock/preview/drip state per lesson + enrollment card with coupon quote. */
export default function CourseDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [coupon, setCoupon] = useState('');
  const [openUnits, setOpenUnits] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState('');

  const { data: course, isLoading, error } = useQuery({
    queryKey: ['course', id],
    queryFn: async () => (await api.get(`/courses/${id}`)).data,
    retry: false,
  });

  const quote = useMutation({
    mutationFn: async (couponCode: string) =>
      (await api.post('/enrollments/quote', { courseId: id, couponCode: couponCode || undefined }))
        .data,
  });

  const enroll = useMutation({
    mutationFn: async () =>
      (await api.post('/enrollments', { courseId: id, couponCode: coupon || undefined })).data,
    onSuccess: (data) => {
      setFlash(data.status === 'ACTIVE' ? t('course.enrolledNow') : t('course.requestSent'));
      queryClient.invalidateQueries({ queryKey: ['course', id] });
      queryClient.invalidateQueries({ queryKey: ['my-enrollments'] });
    },
  });

  if (isLoading) return <Spinner />;
  if (error || !course) return <EmptyState icon="menu_book" title={t('course.notFound')} />;

  const total = course.units.reduce(
    (acc: { lessons: number; sec: number }, u: any) => ({
      lessons: acc.lessons + u.lessons.length,
      sec: acc.sec + u.lessons.reduce((s: number, l: any) => s + l.durationSec, 0),
    }),
    { lessons: 0, sec: 0 },
  );
  const enrollmentStatus: string | null = course.viewer.enrollmentStatus;
  const isStudent = user?.role === Role.STUDENT;
  const priced = quote.data;

  const statusBanner =
    enrollmentStatus === 'PENDING_APPROVAL'
      ? { tone: 'warn', icon: 'hourglass_top', text: t('course.statusPending') }
      : enrollmentStatus === 'ACTIVE' && course.viewer.hasAccess
        ? { tone: 'teal', icon: 'check_circle', text: t('course.statusActive') }
        : enrollmentStatus === 'REJECTED'
          ? { tone: 'error', icon: 'block', text: t('course.statusRejected') }
          : enrollmentStatus === 'REVOKED'
            ? { tone: 'error', icon: 'lock', text: t('course.statusRevoked') }
            : enrollmentStatus === 'ACTIVE' || enrollmentStatus === 'EXPIRED'
              ? { tone: 'warn', icon: 'schedule', text: t('course.statusExpired') }
              : null;
  const canEnroll =
    isStudent &&
    (!enrollmentStatus || ['REJECTED', 'REVOKED', 'EXPIRED'].includes(enrollmentStatus) ||
      (enrollmentStatus === 'ACTIVE' && !course.viewer.hasAccess));

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Main column */}
        <div className="min-w-0 flex-1">
          <div className="card mb-6 p-8">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-outline">
              {course.subject && <Badge>{course.subject.nameAr}</Badge>}
              {course.grade && <Badge tone="neutral">{course.grade.nameAr}</Badge>}
              {course.status !== 'PUBLISHED' && <Badge tone="warn">{t(`teacher.courses.status.${course.status}`)}</Badge>}
            </div>
            <h1 className="mb-3 font-heading text-3xl font-extrabold">{course.title}</h1>
            <p className="mb-4 leading-relaxed text-on-surface-variant">{course.description}</p>
            <div className="flex flex-wrap items-center gap-5 text-sm text-on-surface-variant">
              <Link to={`/t/${course.teacher.slug}`} className="flex items-center gap-2 font-bold text-primary hover:underline">
                <span className="material-symbols-outlined">person</span>
                {course.teacher.fullName}
              </Link>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">smart_display</span>
                {t('course.lessonsCount', { count: total.lessons })}
              </span>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">schedule</span>
                {duration(total.sec)}
              </span>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-base">group</span>
                {t('course.students', { count: course.studentsCount })}
              </span>
              {course.avgRating != null && (
                <span className="flex items-center gap-1 font-bold text-accent">
                  ★ {course.avgRating}
                </span>
              )}
            </div>
          </div>

          {/* Curriculum */}
          <h2 className="mb-4 font-heading text-2xl font-extrabold">{t('course.curriculum')}</h2>
          <div className="space-y-4">
            {course.units.map((u: any, ui: number) => {
              const open = openUnits[u.id] ?? ui === 0;
              return (
                <div key={u.id} className="card p-0">
                  <button
                    className="flex w-full items-center justify-between px-6 py-4"
                    onClick={() => setOpenUnits({ ...openUnits, [u.id]: !open })}
                  >
                    <span className="flex items-center gap-3">
                      <Badge>{t('teacher.builder.unitBadge', { n: ui + 1 })}</Badge>
                      <span className="font-heading text-lg font-bold">{u.title}</span>
                    </span>
                    <span className="flex items-center gap-3 text-sm text-outline">
                      {t('course.lessonsCount', { count: u.lessons.length })}
                      <span className="material-symbols-outlined">{open ? 'expand_less' : 'expand_more'}</span>
                    </span>
                  </button>
                  {open && (
                    <ul className="border-t border-outline-variant/40">
                      {u.lessons.map((l: any) => (
                        <li key={l.id} className={`flex items-center gap-4 px-6 py-4 ${l.locked ? 'opacity-60' : ''}`}>
                          <span
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                              l.locked ? 'bg-surface-container-high text-outline' : 'bg-secondary-container text-on-secondary-container'
                            }`}
                          >
                            <span className="material-symbols-outlined">
                              {l.locked ? 'lock' : LESSON_ICON[l.type] ?? 'play_circle'}
                            </span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-bold">{l.title}</p>
                            <p className="flex flex-wrap items-center gap-3 text-xs text-outline">
                              {l.durationSec > 0 && <span>{duration(l.durationSec)}</span>}
                              {l.locked && l.dripUnlockAt && <span>{t('course.unlocksOn', { date: dateShort(l.dripUnlockAt) })}</span>}
                              {l.locked && !l.dripUnlockAt && l.dripAfterEnrollDays != null && (
                                <span>{t('course.unlocksAfterDays', { count: l.dripAfterEnrollDays })}</span>
                              )}
                              {l.attachments?.length > 0 && (
                                <span>{t('course.attachmentsCount', { count: l.attachments.length })}</span>
                              )}
                            </p>
                          </div>
                          {l.isFreePreview && <Badge tone="teal">{t('course.freePreview')}</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Enroll card */}
        <aside className="h-fit w-full shrink-0 lg:sticky lg:top-8 lg:w-96">
          <div className="card overflow-hidden p-0">
            <div className="h-44 bg-surface-container-high">
              {course.thumbnailUrl && <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="p-6">
              <p className="text-sm text-outline">{t('course.priceLabel')}</p>
              <p className="mb-4 font-heading text-4xl font-extrabold">
                {course.priceCents === 0 ? t('common.free') : egp(priced?.totalCents ?? course.priceCents)}
                {course.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
                  <span className="text-sm font-normal text-outline"> / {t('course.perMonth')}</span>
                )}
              </p>

              {priced && priced.discountCents > 0 && (
                <div className="mb-4 space-y-1 rounded-lg bg-secondary-container/40 p-3 text-sm">
                  <p className="flex justify-between"><span>{t('course.basePrice')}</span><span>{egp(priced.basePriceCents)}</span></p>
                  <p className="flex justify-between text-secondary"><span>{t('course.discount')} ({priced.coupon?.code})</span><span>-{egp(priced.discountCents)}</span></p>
                  <p className="flex justify-between font-bold"><span>{t('course.total')}</span><span>{egp(priced.totalCents)}</span></p>
                </div>
              )}

              {statusBanner && (
                <p className={`mb-4 flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-bold ${
                  statusBanner.tone === 'teal'
                    ? 'bg-secondary-container/50 text-on-secondary-container'
                    : statusBanner.tone === 'warn'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-error-container text-on-error-container'
                }`}>
                  <span className="material-symbols-outlined">{statusBanner.icon}</span>
                  {statusBanner.text}
                </p>
              )}
              {flash && !statusBanner && (
                <p className="mb-4 rounded-lg bg-secondary-container/50 px-4 py-3 text-sm font-bold text-on-secondary-container">{flash}</p>
              )}

              {canEnroll && (
                <>
                  {course.priceCents > 0 && (
                    <div className="mb-3 flex gap-2">
                      <input
                        className="input py-2"
                        placeholder={t('course.couponPlaceholder')}
                        value={coupon}
                        onChange={(e) => setCoupon(e.target.value)}
                      />
                      <button
                        className="btn-ghost px-4 py-2 text-sm"
                        disabled={!coupon || quote.isPending}
                        onClick={() => quote.mutate(coupon)}
                      >
                        {t('course.applyCoupon')}
                      </button>
                    </div>
                  )}
                  <button className="btn-primary w-full" disabled={enroll.isPending} onClick={() => enroll.mutate()}>
                    {['EXPIRED'].includes(enrollmentStatus ?? '') || (enrollmentStatus === 'ACTIVE' && !course.viewer.hasAccess)
                      ? t('course.renew')
                      : t('course.enroll')}
                  </button>
                  <p className="mt-3 flex items-center justify-center gap-1 text-center text-xs text-outline">
                    <span className="material-symbols-outlined text-sm">
                      {course.requiresEnrollmentApproval ? 'approval' : 'bolt'}
                    </span>
                    {course.requiresEnrollmentApproval ? t('course.requiresApprovalHint') : t('course.autoApproveHint')}
                  </p>
                </>
              )}
              <ErrorNote error={quote.error ?? enroll.error} />

              {course.bundleCourses?.length > 0 && (
                <div className="mt-5 border-t border-outline-variant/50 pt-4">
                  <p className="mb-2 text-sm font-bold">{t('course.bundleIncludes')}</p>
                  <ul className="space-y-1 text-sm text-on-surface-variant">
                    {course.bundleCourses.map((b: any) => (
                      <li key={b.id}>
                        <Link className="text-primary hover:underline" to={`/course/${b.id}`}>• {b.title}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

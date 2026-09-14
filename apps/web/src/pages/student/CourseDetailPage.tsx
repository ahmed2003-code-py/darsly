import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api, apiOrigin } from '../../lib/api';
import { dateShort, duration, egp } from '../../lib/format';
import { Markdown } from '../../lib/markdown';
import { useAuthStore } from '../../stores/auth';
import { Badge, EmptyState, ErrorNote, Skeleton } from '../../components/ui';
import ReviewModal from '../../components/ReviewModal';
import SaveHeart from '../../components/SaveHeart';
import PaymentModal from '../../components/PaymentModal';

const LESSON_ICON: Record<string, string> = {
  VIDEO: 'play_circle',
  QUIZ: 'quiz',
  ASSIGNMENT: 'assignment',
};

/** Course page per course_curriculum design: curriculum accordion with
 *  lock/preview/drip state per lesson + enrollment card with coupon quote. */
export default function CourseDetailPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [coupon, setCoupon] = useState('');
  const [openUnits, setOpenUnits] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

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

  if (isLoading) {
    return (
      <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
        <div className="flex flex-col gap-8 lg:flex-row">
          <div className="min-w-0 flex-1 space-y-4">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
          <Skeleton className="h-96 w-full rounded-xl lg:w-96" />
        </div>
      </div>
    );
  }
  if (error || !course) return <EmptyState icon="menu_book" title={t('course.notFound')} />;

  const total = course.units.reduce(
    (acc: { lessons: number; sec: number }, u: any) => ({
      lessons: acc.lessons + u.lessons.length,
      sec: acc.sec + u.lessons.reduce((s: number, l: any) => s + l.durationSec, 0),
    }),
    { lessons: 0, sec: 0 },
  );
  // A course can be nothing but a flat list of lessons — only named sections
  // get a number and a header; the unnamed one just isn't labelled, and
  // (being sorted first) opens on its own.
  let sectionNumber = 0;
  const curriculumUnits: { unit: any; sectionN: number | null }[] = course.units.map((u: any) => ({
    unit: u,
    sectionN: u.isDefault ? null : ++sectionNumber,
  }));

  const enrollmentStatus: string | null = course.viewer.enrollmentStatus;
  const isStudent = user?.role === Role.STUDENT;
  const priced = quote.data;

  const statusBanner =
    enrollmentStatus === 'PENDING_PAYMENT'
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
  // A course for other years than the student's own is not something they can
  // buy, so the page says that where the price and the button would be. They
  // can still read it — the teacher's landing page links here, and arriving to
  // a dead end with no explanation is worse than arriving to one with a reason.
  const otherYear = isStudent && course.viewer.forMyYear === false;
  // Named in the reader's own language, and joined with their own comma — the
  // sentence around them is translated, so the years inside it cannot be left
  // in Arabic for an English reader.
  const ar = i18n.language !== 'en';
  const yearNames = (course.grades ?? [])
    .map((g: { nameAr: string; nameEn: string }) => (ar ? g.nameAr : g.nameEn))
    .join(ar ? '، ' : ', ');
  const canEnroll =
    isStudent &&
    !otherYear &&
    (!enrollmentStatus || ['REJECTED', 'REVOKED', 'EXPIRED'].includes(enrollmentStatus) ||
      (enrollmentStatus === 'ACTIVE' && !course.viewer.hasAccess));

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Main column */}
        <div className="min-w-0 flex-1">
          <div className="card mb-6 p-8">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-outline">
              {course.subject && <Badge>{course.subject.nameAr}</Badge>}
              {(course.grades ?? []).map((g: { id: string; nameAr: string }) => (
                <Badge key={g.id} tone="neutral">{g.nameAr}</Badge>
              ))}
              {course.status !== 'PUBLISHED' && <Badge tone="warn">{t(`teacher.courses.status.${course.status}`)}</Badge>}
            </div>
            <h1 className="mb-3 font-heading text-3xl font-extrabold">{course.title}</h1>
            <Markdown className="mb-4 text-on-surface-variant">{course.description}</Markdown>
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
                  <span className="font-normal text-outline">({course.reviewsCount})</span>
                </span>
              )}
              {course.viewer.hasAccess && course.viewer.enrollmentStatus === 'ACTIVE' && user?.role === Role.STUDENT && (
                <button className="flex items-center gap-1 text-primary hover:underline" onClick={() => setReviewOpen(true)}>
                  <span className="material-symbols-outlined text-base">rate_review</span>
                  {t('review.write')}
                </button>
              )}
            </div>
            {user?.role === Role.STUDENT && (
              <div className="mt-4"><SaveHeart courseId={course.id} /></div>
            )}
          </div>
          {course.id && (
            <>
              <ReviewModal open={reviewOpen} onClose={() => setReviewOpen(false)} courseId={course.id} />
              <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} courseId={course.id}
                amountCents={priced?.totalCents ?? course.priceCents} couponCode={priced?.coupon?.code} />
            </>
          )}

          {/* The exam, before the curriculum and before anything else a student
              could click. Asked for in exactly those words: it should be in
              your face the moment you come in, not something you find. */}
          {course.viewer?.hasAccess && course.entryExam?.lessonId && !course.entryExam.passed && (
            <div className="card mb-6 border-primary/40 bg-primary-fixed/30">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
                  <span className="material-symbols-outlined">quiz</span>
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-heading text-lg font-extrabold">{t('course.examTitle')}</h2>

                  {course.entryExam.awaitingGrading ? (
                    <p className="mt-1 text-sm text-on-surface-variant">{t('course.examWaiting')}</p>
                  ) : (
                    <p className="mt-1 text-sm text-on-surface-variant">{t('course.examBody')}</p>
                  )}

                  {course.entryExam.bestScorePct != null && (
                    <p className="mt-1 text-sm font-bold text-student-gold-ink">
                      {t('course.examBest', { pct: course.entryExam.bestScorePct })}
                    </p>
                  )}

                  {/* Failed, and the teacher left something to watch. The lesson
                      comes first: sending somebody straight back to a paper they
                      just failed is not teaching them anything. */}
                  {course.entryExam.attempted
                    && !course.entryExam.awaitingGrading
                    && course.entryExam.remedialLessonId && (
                    <div className="mt-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3">
                      <p className="text-sm font-bold">{t('course.examRemedial')}</p>
                      <p className="mt-0.5 text-xs text-on-surface-variant">{t('course.examRemedialBody')}</p>
                      <Link
                        to={`/learn/${course.id}/${course.entryExam.remedialLessonId}`}
                        className="btn-primary mt-2 inline-flex items-center gap-1.5 py-2 text-sm"
                      >
                        <span className="material-symbols-outlined text-[18px]">play_circle</span>
                        {t('course.examRemedial')}
                      </Link>
                    </div>
                  )}

                  {!course.entryExam.awaitingGrading && (
                    <Link
                      to={`/learn/${course.id}/${course.entryExam.lessonId}`}
                      className={`mt-3 inline-flex items-center gap-1.5 py-2 text-sm ${
                        course.entryExam.remedialLessonId && course.entryExam.attempted ? 'btn-ghost' : 'btn-primary'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[18px]">edit_note</span>
                      {course.entryExam.attempted ? t('course.examRetry') : t('course.examStart')}
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )}

          {course.viewer?.hasAccess && course.entryExam?.lessonId && course.entryExam.passed && (
            <p className="mb-4 flex items-center gap-1.5 text-sm font-bold text-secondary">
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              {t('course.examPassed')}
            </p>
          )}

          {/* Curriculum */}
          <h2 className="mb-4 font-heading text-2xl font-extrabold">{t('course.curriculum')}</h2>
          <div className="space-y-4">
            {curriculumUnits.map(({ unit: u, sectionN }) => {
              // No section, no toggle — the unnamed unit's lessons are just there.
              const open = sectionN == null ? true : (openUnits[u.id] ?? sectionN === 1);
              return (
                <div key={u.id} className="card p-0">
                  {sectionN != null && (
                    <button
                      className="flex w-full items-center justify-between px-6 py-4"
                      onClick={() => setOpenUnits({ ...openUnits, [u.id]: !open })}
                    >
                      <span className="flex items-center gap-3">
                        <Badge>{t('teacher.builder.unitBadge', { n: sectionN })}</Badge>
                        <span className="font-heading text-lg font-bold">{u.title}</span>
                      </span>
                      <span className="flex items-center gap-3 text-sm text-outline">
                        {t('course.lessonsCount', { count: u.lessons.length })}
                        <span className="material-symbols-outlined">{open ? 'expand_less' : 'expand_more'}</span>
                      </span>
                    </button>
                  )}
                  {open && (
                    <ul className="border-t border-outline-variant/40">
                      {u.lessons.map((l: any) => {
                        const Row = (
                          <>
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
                            {!l.locked && (
                              <span className="material-symbols-outlined text-primary">
                                {l.type === 'QUIZ' ? 'quiz' : l.type === 'ASSIGNMENT' ? 'assignment' : 'play_circle'}
                              </span>
                            )}
                          </>
                        );
                        return l.locked ? (
                          <li key={l.id} className="flex items-center gap-4 px-6 py-4 opacity-60">{Row}</li>
                        ) : (
                          <li key={l.id}>
                            <Link
                              to={`/learn/${course.id}/${l.id}`}
                              className="flex items-center gap-4 px-6 py-4 transition hover:bg-surface-container-low"
                            >
                              {Row}
                            </Link>
                          </li>
                        );
                      })}
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
            {/* The teacher's pitch plays where the cover used to sit: right
                above the price, which is the moment it has to do its work.
                The cover becomes its poster, so nothing is lost. */}
            <div className="h-44 bg-surface-container-high">
              {course.introVideoUrl ? (
                <video
                  src={apiOrigin() + course.introVideoUrl}
                  poster={course.thumbnailUrl ?? undefined}
                  controls
                  playsInline
                  preload="none"
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                course.thumbnailUrl && <img src={course.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              )}
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

              {otherYear && (
                <p className="mb-1 flex items-start gap-2 rounded-xl bg-secondary-container/60 px-4 py-3 text-sm font-bold text-on-secondary-container">
                  <span className="material-symbols-outlined text-base">school</span>
                  <span>
                    {t('course.otherYear', { years: yearNames })}
                  </span>
                </p>
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
                  <button
                    className="btn-primary w-full"
                    disabled={enroll.isPending}
                    onClick={() => (course.priceCents > 0 ? setPayOpen(true) : enroll.mutate())}
                  >
                    {course.priceCents > 0
                      ? t('course.payAndEnroll')
                      : ['EXPIRED'].includes(enrollmentStatus ?? '') || (enrollmentStatus === 'ACTIVE' && !course.viewer.hasAccess)
                        ? t('course.renew')
                        : t('course.enroll')}
                  </button>
                  <p className="mt-3 flex items-center justify-center gap-1 text-center text-xs text-outline">
                    <span className="material-symbols-outlined text-sm">{course.priceCents > 0 ? 'verified_user' : 'bolt'}</span>
                    {course.priceCents > 0 ? t('course.payHint') : t('course.autoApproveHint')}
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

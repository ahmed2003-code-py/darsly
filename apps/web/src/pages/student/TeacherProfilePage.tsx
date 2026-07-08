import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { duration, egp } from '../../lib/format';
import { Badge, EmptyState, Spinner, Stars } from '../../components/ui';

/** Public teacher profile per the teacher_profile design: hero with intro
 *  video + stats chips, then course cards, then reviews. */
export default function TeacherProfilePage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const { slug } = useParams();

  const { data: teacher, isLoading } = useQuery({
    queryKey: ['teacher', slug],
    queryFn: async () => (await api.get(`/teachers/${slug}`)).data,
  });

  if (isLoading) return <Spinner />;
  if (!teacher) return <EmptyState icon="person_off" title={t('discovery.noResults')} />;

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      {/* Hero */}
      <section className="card mb-10 grid gap-8 bg-gradient-to-bl from-surface-container-low to-surface-container-lowest p-8 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <h1 className="font-heading text-4xl font-extrabold">{teacher.fullName}</h1>
            {teacher.verified && <Badge tone="teal">{t('teacherProfile.verifiedTeacher')}</Badge>}
          </div>
          <p className="mb-3 font-heading text-xl font-bold text-primary">
            {teacher.subject ? (ar ? teacher.subject.nameAr : teacher.subject.nameEn) : ''}
            {teacher.grades?.length
              ? ` — ${teacher.grades.map((g: any) => (ar ? g.nameAr : g.nameEn)).join('، ')}`
              : ''}
          </p>
          <p className="mb-6 leading-relaxed text-on-surface-variant">{teacher.bio}</p>
          <div className="flex flex-wrap gap-3">
            <span className="flex items-center gap-2 rounded-lg bg-primary-fixed/60 px-4 py-2 font-bold text-on-primary-fixed-variant">
              <span className="material-symbols-outlined">group</span>
              {t('teacherProfile.studentsChip', { count: teacher.stats.studentsCount })}
            </span>
            <span className="flex items-center gap-2 rounded-lg bg-primary-fixed/60 px-4 py-2 font-bold text-on-primary-fixed-variant">
              <Stars rating={teacher.stats.avgRating} />
              {t('teacherProfile.ratingChip', { count: teacher.stats.reviewsCount })}
            </span>
          </div>
        </div>

        <div className="relative flex min-h-56 items-center justify-center overflow-hidden rounded-xl bg-inverse-surface shadow-modal">
          {teacher.avatarUrl && (
            <img src={teacher.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
          )}
          <div className="relative flex flex-col items-center gap-2 text-inverse-on-surface">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-container shadow-modal">
              <span className="material-symbols-outlined text-4xl text-on-primary">play_arrow</span>
            </span>
            <p className="text-sm">{t('teacherProfile.introVideo')}</p>
          </div>
        </div>
      </section>

      {/* Courses */}
      <h2 className="mb-4 border-b border-outline-variant/50 pb-3 font-heading text-2xl font-extrabold">
        {t('teacherProfile.coursesTitle')}
      </h2>
      {!teacher.courses.length ? (
        <EmptyState icon="menu_book" title={t('teacherProfile.noCourses')} />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {teacher.courses.map((c: any) => (
            <article key={c.id} className="card flex flex-col overflow-hidden p-0">
              <div className="relative h-40 bg-surface-container-high">
                {c.thumbnailUrl && (
                  <img src={c.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                )}
                {c.subject && (
                  <span className="absolute start-3 top-3 rounded-full bg-on-surface/70 px-3 py-1 text-xs font-bold text-surface">
                    {ar ? c.subject.nameAr : c.subject.nameEn}
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col p-5">
                <h3 className="mb-1 font-heading text-lg font-bold">{c.title}</h3>
                <p className="mb-3 line-clamp-2 flex-1 text-sm text-on-surface-variant">{c.description}</p>
                <div className="mb-3 flex items-center gap-4 text-xs text-outline">
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">smart_display</span>
                    {t('teacherProfile.lessonsCount', { count: c.lessonsCount })}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">schedule</span>
                    {duration(c.totalDurationSec)}
                  </span>
                  {c.freePreviewCount > 0 && (
                    <Badge tone="teal">{t('teacherProfile.freePreviewCount', { count: c.freePreviewCount })}</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-outline-variant/50 pt-3">
                  <p className="font-heading text-xl font-extrabold">
                    {egp(c.priceCents)}
                    {c.pricingModel === 'MONTHLY_SUBSCRIPTION' && (
                      <span className="text-xs font-normal text-outline"> / {t('course.perMonth')}</span>
                    )}
                  </p>
                  <Link to={`/course/${c.id}`} className="btn-primary px-4 py-2 text-sm">
                    {t('teacherProfile.viewCourse')}
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Reviews */}
      {teacher.reviews.length > 0 && (
        <>
          <h2 className="mb-4 mt-10 border-b border-outline-variant/50 pb-3 font-heading text-2xl font-extrabold">
            {t('teacherProfile.reviewsTitle')}
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {teacher.reviews.map((r: any) => (
              <div key={r.id} className="card p-5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-heading font-bold">{r.studentName}</p>
                  <Stars rating={r.rating} />
                </div>
                <p className="text-sm text-on-surface-variant">{r.comment}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

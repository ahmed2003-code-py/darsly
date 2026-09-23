import { Link } from 'react-router-dom';
import { egp } from '../lib/format';
import { Stars } from './ui';

/**
 * A course, as a card — in whichever composition the theme asked for.
 *
 * Extracted from the browse page so the same data can be laid out three ways
 * without the page knowing which. The children are deliberately flat — media,
 * chips, title, teacher, rating, meta, price — each a direct child of the card
 * with its own class, so `data-s-card-layout` on the root can re-arrange them
 * with CSS grid areas alone:
 *
 *   grid        media on top, everything under it — the app as it was
 *   imageFirst  a taller picture with the title laid over its foot
 *   editorial   picture on the start side, text beside it, wider cards
 *
 * Nothing about the course — its price, its teacher, where it links — is any
 * different in any of them. That is the rule: the theme is allowed the
 * composition and nothing else.
 */
export interface CourseCardCourse {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  subject: { id: string; nameAr: string; nameEn: string } | null;
  grades?: { id: string; nameAr: string; nameEn: string }[];
  pricingModel: 'ONE_TIME' | 'MONTHLY_SUBSCRIPTION';
  priceCents: number;
  lessonsCount: number;
  totalDurationSec: number;
  freePreviewCount: number;
  studentsCount: number;
  avgRating: number | null;
  reviewsCount: number;
  teacher: { fullName: string; verified: boolean };
}

export default function CourseCard({
  course: c,
  ar,
  t,
  name,
}: {
  course: CourseCardCourse;
  ar: boolean;
  t: (k: string, o?: Record<string, unknown>) => string;
  name: (x: { nameAr: string; nameEn: string } | null | undefined) => string;
}) {
  const hours = Math.floor(c.totalDurationSec / 3600);
  const mins = Math.round((c.totalDurationSec % 3600) / 60);
  return (
    <Link
      to={`/course/${c.id}`}
      className="course-card card card-hover flex h-full flex-col gap-3 overflow-hidden p-0"
    >
      <div className="course-media relative aspect-[16/10] w-full bg-surface-container">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="material-symbols-outlined text-4xl text-outline">menu_book</span>
          </span>
        )}
        {c.freePreviewCount > 0 && (
          <span className="absolute bottom-2 start-2 rounded-lg bg-surface-container-lowest/95 px-2 py-1 text-xs font-bold text-primary">
            {t('browse.freePreview')}
          </span>
        )}
      </div>

      <div className="course-body flex flex-1 flex-col gap-2 px-4 pb-4">
        <div className="course-chips flex flex-wrap items-center gap-1.5 text-xs text-on-surface-variant">
          {c.subject && (
            <span className="rounded-md bg-primary-fixed px-2 py-0.5 font-semibold text-on-primary-fixed-variant">
              {name(c.subject)}
            </span>
          )}
          {(c.grades ?? []).map((g) => (
            <span key={g.id} className="rounded-md bg-surface-container px-2 py-0.5">
              {name(g)}
            </span>
          ))}
        </div>

        <h3 className="course-title line-clamp-2 font-heading text-base font-bold leading-snug">
          {c.title}
        </h3>

        <p className="course-teacher flex items-center gap-1.5 text-sm text-on-surface-variant">
          {c.teacher.fullName}
          {c.teacher.verified && (
            <span className="material-symbols-outlined text-[14px] text-primary">verified</span>
          )}
        </p>

        {c.avgRating != null ? (
          <span className="course-rating flex items-center gap-1.5 text-sm">
            <Stars rating={c.avgRating} />
            <span className="text-on-surface-variant">({c.reviewsCount})</span>
          </span>
        ) : (
          <span className="course-rating text-sm text-outline">{t('browse.noReviews')}</span>
        )}

        <p className="course-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[15px]">play_lesson</span>
            {t('browse.lessons', { n: c.lessonsCount })}
          </span>
          {c.totalDurationSec > 0 && (
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[15px]">schedule</span>
              {hours ? `${hours}${ar ? 'س' : 'h'} ` : ''}
              {mins}
              {ar ? 'د' : 'm'}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[15px]">group</span>
            {c.studentsCount}
          </span>
        </p>

        <div className="course-price mt-auto flex items-end justify-between gap-2 border-t border-outline-variant pt-3">
          <span>
            <span className="block text-[11px] text-on-surface-variant">
              {c.pricingModel === 'MONTHLY_SUBSCRIPTION' ? t('browse.perMonth') : t('browse.price')}
            </span>
            <span className="font-heading text-lg font-bold">
              {c.priceCents === 0 ? t('browse.free') : egp(c.priceCents)}
            </span>
          </span>
          <span className="btn-secondary px-4 py-2 text-xs">{t('browse.view')}</span>
        </div>
      </div>
    </Link>
  );
}

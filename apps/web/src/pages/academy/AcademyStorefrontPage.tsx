import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AcademyProvider, { useAcademy } from '../../components/AcademyProvider';
import Layout from '../../components/Layout';
import ColorModeToggle from '../../components/ColorModeToggle';
import { Reveal, Stagger, StaggerItem } from '../../components/motion';
import { EmptyState, Spinner } from '../../components/ui';
import { api, apiOrigin } from '../../lib/api';
import { egp } from '../../lib/format';
import { AcademyCourseCard, useAcademyCourses, useMyAcademies } from '../../lib/academy';
import { setStudioSuspended } from '../../lib/studio';
import { courseYearsLabel, storefrontView, studentLookSuspended } from '../../lib/storefront';
import { useAuthStore } from '../../stores/auth';

/**
 * `/a/:slug` — an academy's public page.
 *
 * Published in the Studio: that site, full screen, in the teacher's own
 * colours (the student's look stands down for it). Not published: the academy
 * in the current Darsly experience — inside the app for someone signed in
 * (their account, their navigation, their look), in the public frame for a
 * visitor. See lib/storefront.ts for why the old standalone fallback went.
 */
export default function AcademyStorefrontPage() {
  const { slug = '' } = useParams();
  const signedIn = useAuthStore((s) => !!s.accessToken);
  const site = useQuery<{ published: boolean }>({
    queryKey: ['pub-site-status', slug],
    queryFn: async () => (await api.get(`/a/${slug}/site-status`)).data,
    retry: false,
  });
  const view = site.isLoading
    ? null
    : storefrontView({ published: !!site.data?.published, signedIn });

  // Only the published site is the teacher's to colour; the fallback keeps the
  // reader's own look. Stood down while the site is open, restored on leaving.
  const suspend = studentLookSuspended(view);
  useEffect(() => {
    if (!suspend) return;
    setStudioSuspended(true);
    return () => setStudioSuspended(false);
  }, [suspend]);

  if (!view) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (view === 'SITE') {
    return (
      <iframe
        title={slug}
        src={`${apiOrigin()}/api/v1/a/${encodeURIComponent(slug)}`}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    );
  }
  const body = (
    <AcademyProvider slug={slug}>
      <Storefront slug={slug} signedIn={view === 'APP'} />
    </AcademyProvider>
  );
  return view === 'APP' ? <Layout>{body}</Layout> : <PublicFrame>{body}</PublicFrame>;
}

/** A visitor's frame: the platform's tokens and light/dark switch, a way to sign in. */
function PublicFrame({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="min-h-screen bg-surface text-on-surface" dir={i18n.dir()}>
      <header className="glass sticky top-0 z-40">
        <div className="mx-auto flex h-16 max-w-container items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="font-heading text-xl font-extrabold text-primary">
            {t('brand')}
          </Link>
          <div className="ms-auto flex items-center gap-2">
            <ColorModeToggle />
            <Link to="/login" className="btn-secondary px-4 py-2 text-sm">
              {t('storefront.login')}
            </Link>
            <Link to="/register" className="btn-primary hidden px-4 py-2 text-sm sm:inline-flex">
              {t('storefront.register')}
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function Storefront({ slug, signedIn }: { slug: string; signedIn: boolean }) {
  const { t, i18n } = useTranslation();
  const { branding, isLoading, error } = useAcademy();
  const { data: courses, isLoading: coursesLoading } = useAcademyCourses(slug);
  const mine = useMyAcademies();
  // The academy's own staff are told their Studio page is not live yet.
  const isStaff = signedIn && !!mine.data?.some((a) => a.slug === slug);

  if (isLoading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }
  if (error || !branding) {
    return (
      <div className="grid min-h-[60vh] place-items-center p-6 text-center">
        <div className="max-w-sm space-y-3">
          <span className="material-symbols-outlined text-5xl text-outline">search_off</span>
          <h1 className="font-heading text-xl font-bold">{t('storefront.notFound')}</h1>
          <p className="text-sm text-on-surface-variant">{t('storefront.notFoundBody')}</p>
          <Link to="/discover" className="btn-primary mt-2">
            {t('storefront.browse')}
          </Link>
        </div>
      </div>
    );
  }

  const initial = branding.name?.trim()?.charAt(0) ?? '?';
  return (
    <div className="mx-auto w-full max-w-container px-4 py-6 sm:px-6" dir={i18n.dir()}>
      {isStaff && (
        <div
          role="status"
          className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <span className="material-symbols-outlined">visibility_off</span>
          <span className="min-w-0 flex-1">{t('storefront.notLiveForStaff')}</span>
          <Link to="/academy/studio" className="btn-secondary px-3 py-1.5 text-xs">
            {t('storefront.openStudio')}
          </Link>
        </div>
      )}

      {/* The academy's identity, on the platform's own surfaces. */}
      <section className="card relative mb-8 overflow-hidden p-0">
        {branding.coverUrl && (
          <img src={branding.coverUrl} alt="" className="h-40 w-full object-cover sm:h-52" />
        )}
        <div className="flex items-center gap-4 p-5 sm:p-6">
          <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-primary-fixed font-heading text-2xl font-bold text-on-primary-fixed">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              initial
            )}
          </span>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold tracking-tight">{branding.name}</h1>
            {branding.tagline && <p className="mt-1 text-on-surface-variant">{branding.tagline}</p>}
            <p className="mt-2 text-sm text-on-surface-variant">
              {t('storefront.courseCount', { count: courses?.length ?? 0 })}
            </p>
          </div>
        </div>
      </section>

      <Reveal className="mb-4 flex items-center gap-2">
        <span className="h-5 w-1 rounded-full bg-primary" />
        <h2 className="font-heading text-xl font-bold tracking-tight">{t('storefront.courses')}</h2>
      </Reveal>
      {coursesLoading ? (
        <Spinner />
      ) : !courses?.length ? (
        <EmptyState icon="menu_book" title={t('storefront.noCourses')} />
      ) : (
        <Stagger className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {courses.map((c) => (
            <StaggerItem key={c.id} className="h-full">
              <CourseCard course={c} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {!signedIn && (
        <p className="mt-10 text-center text-sm text-on-surface-variant">
          {t('storefront.poweredBy')}{' '}
          <Link to="/discover" className="font-semibold text-primary">
            {t('brand')}
          </Link>
        </p>
      )}
    </div>
  );
}

function CourseCard({ course: c }: { course: AcademyCourseCard }) {
  const { t, i18n } = useTranslation();
  const monthly = c.pricingModel === 'MONTHLY_SUBSCRIPTION';
  const en = i18n.language.startsWith('en');
  // The years come as grades[] (the API stopped sending a single `grade`).
  const years = courseYearsLabel(c.grades, i18n.language);
  const subject = c.subject ? (en ? c.subject.nameEn : c.subject.nameAr) : null;
  return (
    <Link
      to={`/course/${c.id}`}
      className="card card-hover flex h-full flex-col overflow-hidden p-0"
    >
      <div className="relative h-36 bg-surface-container-high">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center text-primary">
            <span className="material-symbols-outlined text-5xl">menu_book</span>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        {(subject || years) && (
          <p className="truncate text-xs text-primary">
            {[subject, years].filter(Boolean).join(' · ')}
          </p>
        )}
        <h3 className="mt-0.5 line-clamp-2 font-heading font-bold">{c.title}</h3>
        {c.teacherName && <p className="mt-1 text-xs text-outline">{c.teacherName}</p>}
        <div className="mt-auto flex items-center justify-between pt-3">
          <span className="text-xs text-outline">
            {t('storefront.lessonCount', { count: c.lessonsCount })}
          </span>
          <span className="font-heading text-lg font-bold tabular-nums">
            {c.priceCents > 0 ? egp(c.priceCents) : t('common.free')}
            {monthly && c.priceCents > 0 && (
              <span className="text-xs font-normal text-outline">{t('common.perMonth')}</span>
            )}
          </span>
        </div>
      </div>
    </Link>
  );
}

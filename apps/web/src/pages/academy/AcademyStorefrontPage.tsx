import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import AcademyProvider, { useAcademy } from '../../components/AcademyProvider';
import { Reveal, Stagger, StaggerItem } from '../../components/motion';
import { EmptyState, Spinner } from '../../components/ui';
import { api, apiOrigin } from '../../lib/api';
import { egp } from '../../lib/format';
import { AcademyCourseCard, useAcademyCourses } from '../../lib/academy';

/** Public, academy-branded landing at /a/:slug. When the academy has published
 *  an AI-generated site, that page is shown (full-viewport); otherwise the
 *  built-in storefront is the fallback. */
export default function AcademyStorefrontPage() {
  const { slug = '' } = useParams();
  const site = useQuery<{ published: boolean }>({
    queryKey: ['pub-site-status', slug],
    queryFn: async () => (await api.get(`/a/${slug}/site-status`)).data,
    retry: false,
  });

  if (site.isLoading) {
    return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  }
  if (site.data?.published) {
    return (
      <iframe
        title={slug}
        src={`${apiOrigin()}/api/v1/a/${encodeURIComponent(slug)}`}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0 }}
      />
    );
  }
  return (
    <AcademyProvider slug={slug}>
      <Storefront slug={slug} />
    </AcademyProvider>
  );
}

function Storefront({ slug }: { slug: string }) {
  const { branding, isLoading, error } = useAcademy();
  const { data: courses, isLoading: coursesLoading } = useAcademyCourses(slug);

  if (isLoading) {
    return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  }
  if (error || !branding) {
    return (
      <div dir="rtl" className="grid min-h-screen place-items-center bg-surface p-6 text-center">
        <div className="max-w-sm space-y-3">
          <div className="text-4xl">🔍</div>
          <h1 className="font-heading text-xl font-bold">الأكاديمية غير موجودة</h1>
          <p className="text-sm text-on-surface-variant">تأكد من الرابط، أو تصفّح الأكاديميات المتاحة.</p>
          <Link to="/discover" className="btn-primary mt-2">تصفّح الأكاديميات</Link>
        </div>
      </div>
    );
  }

  const accent = branding.colorPrimary || '#4A32C9';
  const initial = branding.name?.trim()?.charAt(0) ?? '؟';

  return (
    <div dir="rtl" className="min-h-screen bg-surface">
      {/* Slim top bar — academy identity + sign-in */}
      <header className="glass sticky top-0 z-40">
        <div className="mx-auto flex h-16 max-w-container items-center gap-3 px-6">
          <AcademyMark logoUrl={branding.logoUrl} initial={initial} accent={accent} size={9} />
          <span className="font-heading text-lg font-bold tracking-tight">{branding.name}</span>
          <div className="ms-auto flex items-center gap-2">
            <Link to="/login" className="btn-secondary px-4 py-2 text-sm">تسجيل الدخول</Link>
          </div>
        </div>
      </header>

      {/* Branded hero — academy color, not platform color */}
      <section
        className="relative overflow-hidden"
        style={{ background: branding.coverUrl ? undefined : accent }}
      >
        {branding.coverUrl && (
          <>
            <img src={branding.coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <span className="absolute inset-0" style={{ background: accent, opacity: 0.82 }} />
          </>
        )}
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.10)_1px,transparent_0)] [background-size:24px_24px]" />
        <div className="relative mx-auto flex max-w-container flex-col gap-5 px-6 py-14 text-white sm:py-20">
          <Reveal className="flex items-center gap-4">
            <AcademyMark logoUrl={branding.logoUrl} initial={initial} accent={accent} size={16} onLight />
            <div>
              <h1 className="display leading-tight text-white">{branding.name}</h1>
              {branding.tagline && <p className="mt-1 max-w-xl text-white/85">{branding.tagline}</p>}
            </div>
          </Reveal>
          <Reveal delay={0.06} className="flex flex-wrap gap-3 pt-2">
            <span className="rounded-full border border-white/25 bg-white/10 px-4 py-1.5 text-sm font-semibold">
              {courses?.length ?? 0} كورس
            </span>
            <span className="rounded-full border border-white/25 bg-white/10 px-4 py-1.5 text-sm font-semibold">
              {branding.language === 'en' ? 'English' : 'بالعربية'}
            </span>
          </Reveal>
        </div>
      </section>

      {/* Courses */}
      <main className="mx-auto max-w-container px-6 py-10">
        <Reveal className="mb-6 flex items-center gap-2">
          <span className="h-5 w-1 rounded-full" style={{ background: accent }} />
          <h2 className="font-heading text-2xl font-bold tracking-tight">الكورسات</h2>
        </Reveal>

        {coursesLoading ? (
          <Spinner />
        ) : !courses?.length ? (
          <EmptyState icon="menu_book" title="لا توجد كورسات منشورة بعد" />
        ) : (
          <Stagger className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {courses.map((c) => (
              <StaggerItem key={c.id} className="h-full">
                <CourseCard course={c} accent={accent} />
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </main>

      <footer className="border-t border-outline-variant py-8 text-center text-sm text-on-surface-variant">
        مدعوم من <Link to="/discover" className="font-semibold" style={{ color: accent }}>درسلي</Link>
      </footer>
    </div>
  );
}

function AcademyMark({
  logoUrl, initial, accent, size, onLight,
}: { logoUrl: string | null; initial: string; accent: string; size: number; onLight?: boolean }) {
  const cls = `grid shrink-0 place-items-center overflow-hidden rounded-xl font-heading font-bold`;
  const style = onLight
    ? { width: `${size * 0.25}rem`, height: `${size * 0.25}rem`, background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }
    : { width: `${size * 0.25}rem`, height: `${size * 0.25}rem`, background: accent, color: '#fff' };
  return (
    <span className={cls} style={style}>
      {logoUrl ? <img src={logoUrl} alt="" className="h-full w-full object-cover" /> : initial}
    </span>
  );
}

function CourseCard({ course: c, accent }: { course: AcademyCourseCard; accent: string }) {
  const monthly = c.pricingModel === 'MONTHLY_SUBSCRIPTION';
  return (
    <Link to={`/course/${c.id}`} className="card card-hover flex h-full flex-col overflow-hidden p-0">
      <div className="relative h-36 bg-surface-container-high">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center text-4xl" style={{ color: accent }}>
            <span className="material-symbols-outlined text-5xl">menu_book</span>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <p className="truncate text-xs" style={{ color: accent }}>
          {c.subject ? c.subject.nameAr : '—'}
          {c.grade ? ` · ${c.grade.nameAr}` : ''}
        </p>
        <h3 className="mt-0.5 line-clamp-2 font-heading font-bold">{c.title}</h3>
        {c.teacherName && <p className="mt-1 text-xs text-outline">{c.teacherName}</p>}
        <div className="mt-auto flex items-center justify-between pt-3">
          <span className="text-xs text-outline">{c.lessonsCount} درس</span>
          <span className="font-heading text-lg font-bold tabular-nums">
            {c.priceCents > 0 ? egp(c.priceCents) : 'مجاني'}
            {monthly && c.priceCents > 0 && <span className="text-xs font-normal text-outline"> /شهرياً</span>}
          </span>
        </div>
      </div>
    </Link>
  );
}

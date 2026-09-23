import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import CourseCard from '../../components/CourseCard';
import { ProgressBar } from '../../components/ui';
import { api } from '../../lib/api';
import { applyStudio, playActivation, previewStudio, restoreStudio } from '../../lib/studio';
import { useAuthStore } from '../../stores/auth';

/**
 * A theme, worn by the whole app, before it is bought.
 *
 * Not a mock-up. This page is rendered inside the real shell, and on mount it
 * paints the candidate theme's tokens and attributes onto the root exactly as
 * equipping it would — so the sidebar, the header, the footer and the bottom
 * bar around this page are the theme's own, for real. What the page itself
 * shows is everything the shell does not: a greeting, a course grid, a stats
 * card, buttons, a form field, a profile card — the surfaces a student meets
 * every day, in the theme's composition.
 *
 * Purely local. Leaving the page restores whatever was equipped, and nothing
 * is written anywhere until "unlock" or "equip" is pressed.
 */
export default function ThemePreviewPage() {
  const { key } = useParams<{ key: string }>();
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuthStore();

  const { data } = useQuery({
    queryKey: ['studio'],
    queryFn: async () => (await api.get('/student/studio')).data,
  });
  const item = useMemo(() => (data?.items ?? []).find((i: any) => i.key === key), [data, key]);
  const equipped = data?.equipped?.themeKey === key;

  // On, for as long as the page is; off the moment it is not.
  useEffect(() => {
    if (!item?.preview) return;
    previewStudio(item.preview);
    return () => restoreStudio();
  }, [item]);

  const after = (theme: unknown) => {
    applyStudio(theme);
    playActivation();
    qc.invalidateQueries({ queryKey: ['studio'] });
    qc.invalidateQueries({ queryKey: ['gamification'] });
  };
  const unlock = useMutation({
    mutationFn: async () => (await api.post('/student/studio/unlock', { key })).data,
    onSuccess: () => equip.mutate(),
  });
  const equip = useMutation({
    mutationFn: async () => (await api.post('/student/studio/equip', { key })).data,
    onSuccess: (d) => {
      after(d.theme);
      navigate('/studio');
    },
  });

  if (!data) return null;
  if (!item) {
    return (
      <div className="page">
        <p className="text-on-surface-variant">{t('myStudio.previewMissing')}</p>
        <Link to="/studio" className="btn-ghost mt-3 inline-flex">
          {t('myStudio.backToStudio')}
        </Link>
      </div>
    );
  }

  const name = ar ? item.name.ar : item.name.en;
  const desc = ar ? item.description.ar : item.description.en;
  const coins = data.student?.coins ?? data.balance?.coins ?? 0;
  const layout = (item.preview as any)?.styles?.layout;
  const styles = (item.preview as any)?.styles ?? {};
  const nameOf = (x: { nameAr: string; nameEn: string } | null | undefined) =>
    x ? (ar ? x.nameAr : x.nameEn) : '';

  return (
    <div className="page space-y-section">
      {/* The bar that says what this is, and the way out. Sticky so the two
          actions are never below the fold of a page that is meant to be
          scrolled. */}
      <div className="sticky top-2 z-30 flex flex-col gap-3 rounded-2xl border border-outline-variant/40 bg-surface-container-lowest/95 px-4 py-3 shadow-elevated backdrop-blur-md sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="material-symbols-outlined shrink-0 text-student-accent-ink">
            visibility
          </span>
          <div className="min-w-0">
            <p className="font-heading font-bold sm:truncate">
              {t('myStudio.previewingTheme', { name })}
            </p>
            <p className="text-xs text-on-surface-variant sm:truncate">
              {t('myStudio.previewHint')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link to="/studio" className="btn-ghost text-sm">
            {t('myStudio.backToStudio')}
          </Link>
          {equipped ? (
            <span className="flex items-center gap-1 text-sm font-bold text-student-accent-ink">
              <span className="material-symbols-outlined text-[18px]">check_circle</span>
              {t('myStudio.equipped')}
            </span>
          ) : item.owned ? (
            <button
              className="btn-primary text-sm"
              disabled={equip.isPending}
              onClick={() => equip.mutate()}
            >
              {t('myStudio.equip')}
            </button>
          ) : item.purchasable ? (
            <button
              className="btn-primary text-sm"
              disabled={unlock.isPending}
              onClick={() => unlock.mutate()}
            >
              <span className="material-symbols-outlined text-base">paid</span>
              {t('myStudio.unlockFor', { coins: item.costCoins })}
            </button>
          ) : (
            <span className="text-sm text-on-surface-variant">
              {item.levelLocked
                ? t('myStudio.needsLevel', { level: item.requiredLevel })
                : t('myStudio.notForSale')}
            </span>
          )}
        </div>
      </div>

      {/* The greeting, as the dashboard shows it. */}
      <section className="border-s-4 border-student-accent ps-5">
        <h1 className="font-heading text-3xl font-bold tracking-tight">
          {t('dashboardStudent.greeting', { name: user?.fullName?.split(' ')[0] ?? '' })}
        </h1>
        <p className="mt-1 text-on-surface-variant">{desc}</p>
      </section>

      {/* What this theme changes — the structural part, said plainly. */}
      {layout && (
        <section className="card p-5">
          <p className="mb-3 font-heading font-bold">{t('myStudio.whatChanges')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['view_sidebar', t('myStudio.change.nav'), t(`myStudio.nav.${layout.nav.desktop}`)],
              [
                'web_asset',
                t('myStudio.change.header'),
                t(`myStudio.header.${layout.header.variant}`),
              ],
              [
                'density_medium',
                t('myStudio.change.density'),
                t(`myStudio.density.${layout.density}`),
              ],
              ['width', t('myStudio.change.width'), t(`myStudio.width.${layout.width}`)],
              [
                'grid_view',
                t('myStudio.change.cards'),
                t(`myStudio.cardLayout.${styles.cardLayout ?? 'grid'}`),
              ],
              [
                'animation',
                t('myStudio.change.motion'),
                t(`myStudio.motion.${styles.motion ?? 'subtle'}`),
              ],
              [
                'text_fields',
                t('myStudio.change.type'),
                t(`myStudio.font.${styles.font ?? 'default'}`),
              ],
              [
                'dock_to_bottom',
                t('myStudio.change.footer'),
                t(`myStudio.footer.${layout.footer}`),
              ],
            ].map(([icon, label, value]) => (
              <div
                key={label}
                className="flex items-start gap-3 rounded-xl bg-surface-container-low p-3"
              >
                <span className="material-symbols-outlined text-[20px] text-student-accent-ink">
                  {icon}
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-on-surface-variant">{label}</p>
                  <p className="truncate text-sm font-bold">{value}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* The stats card, as the dashboard shows it. */}
      <section className="card p-5">
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-student-gold-soft">
            <span
              className="material-symbols-outlined text-[28px] text-student-gold-ink"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              workspace_premium
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-lg font-bold">{t('myStudio.sample.levelName')}</p>
            <p className="text-sm text-on-surface-variant">{t('myStudio.sample.xp')}</p>
          </div>
          <button className="btn-ghost text-sm">{t('gamification.cta.open')}</button>
        </div>
        <div className="mt-4">
          <ProgressBar pct={64} tone="gold" />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-outline-variant/50 pt-4 text-center">
          {[
            ['local_fire_department', '12', t('gamification.streak'), 'text-student-secondary-ink'],
            ['leaderboard', '#3', t('gamification.rank'), 'text-student-gold-ink'],
            ['toll', '1.2k', t('gamification.coins'), 'text-student-gold-ink'],
          ].map(([icon, v, l, cls]) => (
            <div key={l}>
              <span
                className={`material-symbols-outlined text-[20px] ${cls}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {icon}
              </span>
              <p className="font-heading text-lg font-extrabold leading-none">{v}</p>
              <p className="mt-0.5 text-[11px] text-outline">{l}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Three courses, in the theme's composition. Sample data; the card is
          the real one. */}
      <section>
        <p className="mb-3 font-heading font-bold">{t('myStudio.sample.courses')}</p>
        <div className="course-grid grid gap-card sm:grid-cols-2 lg:grid-cols-3">
          {SAMPLE_COURSES.map((c) => (
            <CourseCard
              key={c.id}
              course={{ ...c, title: ar ? c.titleAr : c.titleEn }}
              ar={ar}
              t={t as any}
              name={nameOf}
            />
          ))}
        </div>
      </section>

      {/* Buttons, a field, a profile — the controls a student presses daily. */}
      <section className="grid gap-card lg:grid-cols-2">
        <div className="card p-5">
          <p className="mb-3 font-heading font-bold">{t('myStudio.sample.controls')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary">{t('browse.view')}</button>
            <button className="btn-secondary px-4 py-2">{t('myStudio.equip')}</button>
            <button className="btn-ghost">{t('common.cancel', 'إلغاء')}</button>
          </div>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-on-surface-variant">
              {t('topbar.searchPlaceholder')}
            </span>
            <input className="input" placeholder={t('topbar.searchPlaceholder')} readOnly />
          </label>
        </div>
        <div className="card flex items-center gap-4 p-5">
          <span className="studio-frame grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading text-xl font-bold text-on-primary-fixed">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              (user?.fullName?.trim()?.charAt(0) ?? '?')
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading font-bold">{user?.fullName}</p>
            <p className="truncate text-sm text-on-surface-variant">
              {t('dashboard.role.STUDENT')}
            </p>
          </div>
          <span className="rounded-full bg-student-accent-soft px-3 py-1 text-xs font-bold text-student-accent-ink">
            {name}
          </span>
        </div>
      </section>

      <p className="text-center text-xs text-on-surface-variant">
        {t('myStudio.previewFooter', { coins })}
      </p>
    </div>
  );
}

/** Three plausible courses. Titles are chosen for both languages. */
const SAMPLE_COURSES = [
  {
    id: 'p1',
    titleAr: 'الجبر — المعادلات من الدرجة الثانية',
    titleEn: 'Algebra — Quadratic Equations',
    thumbnailUrl: null,
    subject: { id: 's1', nameAr: 'رياضيات', nameEn: 'Maths' },
    grades: [{ id: 'g1', nameAr: 'الأول الثانوي', nameEn: 'Grade 10' }],
    pricingModel: 'ONE_TIME' as const,
    priceCents: 15000,
    lessonsCount: 24,
    totalDurationSec: 6 * 3600,
    freePreviewCount: 2,
    studentsCount: 318,
    avgRating: 4.8,
    reviewsCount: 41,
    teacher: { fullName: 'أ. سارة عادل', verified: true },
  },
  {
    id: 'p2',
    titleAr: 'الكيمياء العضوية — من الصفر',
    titleEn: 'Organic Chemistry — From Zero',
    thumbnailUrl: null,
    subject: { id: 's2', nameAr: 'كيمياء', nameEn: 'Chemistry' },
    grades: [{ id: 'g2', nameAr: 'الثاني الثانوي', nameEn: 'Grade 11' }],
    pricingModel: 'MONTHLY_SUBSCRIPTION' as const,
    priceCents: 9000,
    lessonsCount: 40,
    totalDurationSec: 11 * 3600,
    freePreviewCount: 0,
    studentsCount: 122,
    avgRating: 4.6,
    reviewsCount: 19,
    teacher: { fullName: 'أ. محمود يوسف', verified: true },
  },
  {
    id: 'p3',
    titleAr: 'English — Grammar Foundations',
    titleEn: 'English — Grammar Foundations',
    thumbnailUrl: null,
    subject: { id: 's3', nameAr: 'لغة إنجليزية', nameEn: 'English' },
    grades: [],
    pricingModel: 'ONE_TIME' as const,
    priceCents: 0,
    lessonsCount: 12,
    totalDurationSec: 3 * 3600,
    freePreviewCount: 12,
    studentsCount: 940,
    avgRating: null,
    reviewsCount: 0,
    teacher: { fullName: 'Ms. Nour', verified: false },
  },
];

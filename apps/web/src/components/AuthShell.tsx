import { m } from 'framer-motion';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';

/**
 * Split-screen auth layout: an indigo brand-storytelling panel (hidden on
 * mobile) beside the form card. Shared by login / register / forgot / reset.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t, i18n } = useTranslation();

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel — flat indigo, layered same-hue depth, editorial */}
      <aside className="relative hidden overflow-hidden bg-primary text-on-primary lg:flex lg:flex-col lg:justify-between lg:p-14">
        <div className="pointer-events-none absolute inset-0">
          {/* fine dot grid */}
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.08)_1px,transparent_0)] [background-size:26px_26px]" />
          {/* concentric ring motif (same-hue, low contrast) */}
          <span className="absolute -end-40 -top-40 h-[34rem] w-[34rem] rounded-full border border-white/10" />
          <span className="absolute -end-28 -top-28 h-[26rem] w-[26rem] rounded-full border border-white/10" />
          <span className="absolute -bottom-48 -start-32 h-[32rem] w-[32rem] rounded-full bg-accent-900/40 blur-3xl" />
          {/* oversized brand watermark */}
          <span className="material-symbols-outlined absolute -bottom-10 end-6 text-[13rem] leading-none text-white/[0.06]">school</span>
          <span className="absolute inset-y-0 end-0 w-px bg-white/10" />
        </div>

        <div className="relative flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/20 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
            <span className="material-symbols-outlined text-2xl">school</span>
          </span>
          <div className="leading-none">
            <p className="font-heading text-2xl font-bold tracking-tight">{t('brand')}</p>
            <p className="mt-1 text-xs text-on-primary/70">{t('brandTagline')}</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-on-primary/80">
            <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
            منصّة الأكاديميات التعليمية
          </span>
          <h2 className="display text-on-primary">{t('auth.brandHeadline')}</h2>
          <p className="mt-4 text-on-primary/75">{t('auth.brandSub')}</p>
          <ul className="mt-9 space-y-2.5">
            {[
              ['play_lesson', 'auth.featureVideo'],
              ['workspace_premium', 'auth.featureCert'],
              ['shield_lock', 'auth.featureSecure'],
            ].map(([icon, key]) => (
              <li key={key} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 text-on-primary">
                  <span className="material-symbols-outlined text-xl">{icon}</span>
                </span>
                <span className="text-sm font-medium text-on-primary/90">{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-4 text-xs text-on-primary/60">
          <span className="flex items-center gap-1.5"><span className="material-symbols-outlined text-base">encrypted</span>{t('auth.secureNote')}</span>
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative flex flex-col justify-center bg-surface px-6 py-10 sm:px-12">
        <div className="absolute end-6 top-6 flex items-center gap-2">
          <button
            className="rounded-full border border-outline-variant px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition-colors hover:border-transparent hover:bg-surface-container-low hover:text-primary"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            {i18n.language === 'ar' ? 'EN' : 'ع'}
          </button>
        </div>

        <m.div
          className="mx-auto w-full max-w-sm"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Mobile brand */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-on-primary">
              <span className="material-symbols-outlined">school</span>
            </span>
            <span className="font-heading text-xl font-bold tracking-tight text-on-surface">{t('brand')}</span>
          </div>

          <h1 className="display text-on-surface">{title}</h1>
          {subtitle && <p className="mt-2 text-on-surface-variant">{subtitle}</p>}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-6 text-center text-sm text-on-surface-variant">{footer}</div>}
        </m.div>
      </main>
    </div>
  );
}

/** Labelled input with an inline leading icon + optional password reveal. */
export function AuthField({
  icon, type = 'text', value, onChange, placeholder, label, dir, autoComplete, reveal, onReveal, revealed, maxLength,
}: {
  icon: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  dir?: 'ltr' | 'rtl';
  autoComplete?: string;
  reveal?: boolean;
  onReveal?: () => void;
  revealed?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{label}</span>
      <span className="flex items-center rounded-xl border border-outline-variant bg-surface-container-lowest transition-[border-color,box-shadow] duration-150 ease-premium focus-within:border-accent-500 focus-within:ring-4 focus-within:ring-accent-500/10">
        <span className="material-symbols-outlined ps-3 text-[20px] text-outline">{icon}</span>
        <input
          className="w-full bg-transparent px-3 py-2.5 outline-none placeholder:text-outline/70"
          type={type}
          dir={dir}
          value={value}
          autoComplete={autoComplete}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          required
        />
        {reveal && (
          <button type="button" className="pe-3 text-outline hover:text-primary" onClick={onReveal} tabIndex={-1}>
            <span className="material-symbols-outlined text-xl">{revealed ? 'visibility_off' : 'visibility'}</span>
          </button>
        )}
      </span>
    </label>
  );
}

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
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-primary text-on-primary lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute inset-0 opacity-90">
          <span className="absolute -start-24 -top-24 h-80 w-80 rounded-full bg-secondary/30 blur-3xl" />
          <span className="absolute -end-16 bottom-0 h-96 w-96 rounded-full bg-primary-container/40 blur-3xl" />
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.12)_1px,transparent_0)] [background-size:22px_22px] opacity-40" />
        </div>

        <div className="relative flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-on-primary/15 backdrop-blur">
            <span className="material-symbols-outlined text-3xl">school</span>
          </span>
          <div className="leading-none">
            <p className="font-heading text-2xl font-extrabold">{t('brand')}</p>
            <p className="mt-1 text-xs text-on-primary/70">{t('brandTagline')}</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2 className="font-heading text-4xl font-extrabold leading-tight">{t('auth.brandHeadline')}</h2>
          <p className="mt-4 text-on-primary/80">{t('auth.brandSub')}</p>
          <ul className="mt-8 space-y-4">
            {[
              ['play_lesson', 'auth.featureVideo'],
              ['workspace_premium', 'auth.featureCert'],
              ['shield_lock', 'auth.featureSecure'],
            ].map(([icon, key]) => (
              <li key={key} className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-on-primary/15">
                  <span className="material-symbols-outlined text-xl">{icon}</span>
                </span>
                <span className="text-sm text-on-primary/90">{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-2 text-xs text-on-primary/70">
          <span className="material-symbols-outlined text-base">encrypted</span>
          {t('auth.secureNote')}
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative flex flex-col justify-center bg-surface px-6 py-10 sm:px-12">
        <div className="absolute end-6 top-6 flex items-center gap-2">
          <button
            className="rounded-lg border border-outline-variant/60 px-3 py-1.5 text-xs font-bold text-on-surface-variant transition hover:border-primary hover:text-primary"
            onClick={() => setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            {i18n.language === 'ar' ? 'EN' : 'ع'}
          </button>
        </div>

        <div className="mx-auto w-full max-w-sm">
          {/* Mobile brand */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-on-primary">
              <span className="material-symbols-outlined">school</span>
            </span>
            <span className="font-heading text-xl font-extrabold text-primary">{t('brand')}</span>
          </div>

          <h1 className="font-heading text-3xl font-extrabold">{title}</h1>
          {subtitle && <p className="mt-2 text-on-surface-variant">{subtitle}</p>}

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-6 text-center text-sm text-on-surface-variant">{footer}</div>}
        </div>
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
      <span className="mb-1.5 block text-sm font-bold text-on-surface-variant">{label}</span>
      <span className="flex items-center rounded-xl border border-outline-variant bg-surface-container-lowest focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30">
        <span className="material-symbols-outlined ps-3 text-outline">{icon}</span>
        <input
          className="w-full bg-transparent px-3 py-3 outline-none placeholder:text-outline"
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

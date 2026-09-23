import { m, useReducedMotion } from 'framer-motion';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';

/**
 * Split-screen auth layout: a living brand panel beside the form card. Shared
 * by login / register / forgot / reset.
 *
 * The panel moves — slowly. Three soft blobs drift behind a dot grid, the
 * feature cards arrive one after another, and the form's fields step in
 * rather than appear. All of it is ambient, none of it is in the way, and it
 * stops for anyone who has asked their OS for less motion.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
  brandName,
  brandTagline,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Override the platform wordmark — set when the visitor arrived through a
   *  specific academy, so the brand panel matches the door they walked in. */
  brandName?: string;
  brandTagline?: string;
}) {
  const { t, i18n } = useTranslation();
  const still = useReducedMotion();

  // Blobs drift on a loop; each has its own path and period so they never
  // fall into step. Mirrored so the loop has no visible seam.
  const drift = (dx: number, dy: number, seconds: number) =>
    still
      ? {}
      : {
          x: [0, dx, 0],
          y: [0, dy, 0],
          transition: {
            duration: seconds,
            repeat: Infinity,
            repeatType: 'mirror' as const,
            ease: 'easeInOut',
          },
        };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-primary text-on-primary lg:flex lg:flex-col lg:justify-between lg:p-14">
        <div className="pointer-events-none absolute inset-0">
          <m.span
            className="absolute -start-24 -top-24 h-[30rem] w-[30rem] rounded-full bg-accent-300/40 blur-3xl"
            animate={drift(90, 60, 22)}
          />
          <m.span
            className="absolute -bottom-40 -end-20 h-[34rem] w-[34rem] rounded-full bg-accent-900/60 blur-3xl"
            animate={drift(-70, -90, 26)}
          />
          <m.span
            className="absolute start-1/3 top-1/2 h-[22rem] w-[22rem] rounded-full bg-white/10 blur-3xl"
            animate={drift(60, -50, 19)}
          />
          {/* fine dot grid on top of the colour */}
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.10)_1px,transparent_0)] [background-size:26px_26px]" />
          {/* concentric rings, low contrast */}
          <m.span
            className="absolute -end-40 -top-40 h-[34rem] w-[34rem] rounded-full border border-white/10"
            animate={
              still
                ? {}
                : { rotate: 360, transition: { duration: 120, repeat: Infinity, ease: 'linear' } }
            }
          >
            <span className="absolute start-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50" />
          </m.span>
          <span className="absolute -end-28 -top-28 h-[26rem] w-[26rem] rounded-full border border-white/10" />
          <span className="material-symbols-outlined absolute -bottom-10 end-6 text-[13rem] leading-none text-white/[0.06]">
            school
          </span>
          <span className="absolute inset-y-0 end-0 w-px bg-white/10" />
        </div>

        <m.div
          className="relative flex items-center gap-3"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/20 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]">
            <span className="material-symbols-outlined text-2xl">school</span>
          </span>
          <div className="leading-none">
            <p className="font-heading text-2xl font-bold tracking-tight">
              {brandName ?? t('brand')}
            </p>
            <p className="mt-1 text-xs text-on-primary/70">{brandTagline ?? t('brandTagline')}</p>
          </div>
        </m.div>

        <m.div
          className="relative max-w-md"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } } }}
        >
          <m.span
            variants={rise}
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-on-primary/80"
          >
            <span className="relative flex h-1.5 w-1.5">
              {!still && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
              )}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white/90" />
            </span>
            {t('auth.platformTagline')}
          </m.span>
          <m.h2 variants={rise} className="display text-on-primary">
            {t('auth.brandHeadline')}
          </m.h2>
          <m.p variants={rise} className="mt-4 text-on-primary/75">
            {t('auth.brandSub')}
          </m.p>
          <ul className="mt-9 space-y-2.5">
            {[
              ['play_lesson', 'auth.featureVideo'],
              ['workspace_premium', 'auth.featureCert'],
              ['shield_lock', 'auth.featureSecure'],
            ].map(([icon, key]) => (
              <m.li
                key={key}
                variants={rise}
                whileHover={still ? undefined : { x: i18n.dir() === 'rtl' ? -6 : 6 }}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] p-3 backdrop-blur-sm"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 text-on-primary">
                  <span className="material-symbols-outlined text-xl">{icon}</span>
                </span>
                <span className="text-sm font-medium text-on-primary/90">{t(key)}</span>
              </m.li>
            ))}
          </ul>
        </m.div>

        <m.div
          className="relative flex items-center gap-4 text-xs text-on-primary/60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 0.5 }}
        >
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base">encrypted</span>
            {t('auth.secureNote')}
          </span>
        </m.div>
      </aside>

      {/* Form panel */}
      {/* Centred beside the brand panel, but top-aligned on a phone: a short
          form centred in a tall screen leaves half of it empty above the
          fields, which reads as a page that failed to load. */}
      <main className="relative flex flex-col overflow-hidden bg-surface px-6 py-10 sm:px-12 lg:justify-center">
        {/* a whisper of the brand colour behind the card, so the two halves feel like one page */}
        <span className="pointer-events-none absolute -end-32 -top-32 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
        <span className="pointer-events-none absolute -bottom-32 -start-32 h-80 w-80 rounded-full bg-accent-300/20 blur-3xl" />

        <div className="absolute end-6 top-6 flex items-center gap-2">
          <button
            className="rounded-full border border-outline-variant px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition-colors hover:border-transparent hover:bg-surface-container-low hover:text-primary"
            onClick={() => void setLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            {i18n.language === 'ar' ? 'EN' : 'ع'}
          </button>
        </div>

        <m.div
          className="relative mx-auto w-full max-w-sm"
          initial={{ opacity: 0, y: 18, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Mobile brand */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-on-primary">
              <span className="material-symbols-outlined">school</span>
            </span>
            <span className="font-heading text-xl font-bold tracking-tight text-on-surface">
              {brandName ?? t('brand')}
            </span>
          </div>

          <h1 className="display text-on-surface">{title}</h1>
          {subtitle && <p className="mt-2 text-on-surface-variant">{subtitle}</p>}

          {/* Children step in one after another. */}
          <m.div
            className="mt-8"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } } }}
          >
            {children}
          </m.div>

          {footer && (
            <m.div
              className="mt-6 text-center text-sm text-on-surface-variant"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
            >
              {footer}
            </m.div>
          )}
        </m.div>
      </main>
    </div>
  );
}

/** Shared entrance for anything that steps in as part of a staggered group. */
export const rise = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

/**
 * A row of options with one chosen — the pill slides to whichever is picked.
 * Pure CSS on the pill (inline-start + width) so it is right in both text
 * directions without measuring anything.
 */
export function AuthSegmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: string }[];
}) {
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const w = 100 / options.length;
  return (
    <m.div
      variants={rise}
      role="tablist"
      className="relative mb-5 grid rounded-2xl bg-surface-container-low p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute inset-y-1 rounded-xl bg-primary shadow-glow transition-[inset-inline-start] duration-300 ease-premium"
        style={{ insetInlineStart: `calc(${idx * w}% + 0.25rem)`, width: `calc(${w}% - 0.5rem)` }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold transition-colors duration-200 ${
              active ? 'text-on-primary' : 'text-on-surface-variant hover:text-primary'
            }`}
          >
            {o.icon && <span className="material-symbols-outlined text-lg">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </m.div>
  );
}

/** Labelled input with an inline leading icon + optional password reveal. */
export function AuthField({
  icon,
  type = 'text',
  value,
  onChange,
  placeholder,
  label,
  dir,
  autoComplete,
  reveal,
  onReveal,
  revealed,
  maxLength,
  pattern,
  inputMode,
  title,
  optional,
  hint,
  autoFocus,
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
  /** Client-side format check — catches a typo before the request leaves. */
  pattern?: string;
  inputMode?: 'text' | 'tel' | 'email' | 'numeric';
  /** The hint the browser shows when `pattern` fails. */
  title?: string;
  /** May be left empty. */
  optional?: boolean;
  /** A line under the field, for what happens if it's left empty and such. */
  hint?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <m.label variants={rise} className="group mb-4 block">
      <span className="mb-1.5 flex items-baseline justify-between text-sm font-semibold text-on-surface-variant">
        {label}
        {optional && (
          <span className="text-xs font-normal text-outline">{t('common.optional')}</span>
        )}
      </span>
      {/* `dir` sits on the row, not just the input. An email or a phone number
          is written left-to-right inside an Arabic page, and with only the
          input flipped the icon stayed on the page's side while the text began
          on the other — a leading icon with a field's width between it and the
          first character, and the reveal button crowded against the text. */}
      <span
        dir={dir}
        className="flex items-center rounded-xl border border-outline-variant bg-surface-container-lowest transition-[border-color,box-shadow,transform] duration-200 ease-premium focus-within:-translate-y-px focus-within:border-accent-500 focus-within:shadow-glow focus-within:ring-4 focus-within:ring-accent-500/10"
      >
        <span className="ms-3 material-symbols-outlined shrink-0 text-[20px] text-outline transition-colors duration-200 group-focus-within:text-primary">
          {icon}
        </span>
        <input
          className="w-full min-w-0 bg-transparent px-3 py-2.5 outline-none placeholder:text-outline"
          type={type}
          dir={dir}
          value={value}
          autoComplete={autoComplete}
          maxLength={maxLength}
          placeholder={placeholder}
          pattern={pattern}
          inputMode={inputMode}
          title={title}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          required={!optional}
        />
        {reveal && (
          <button
            type="button"
            className="shrink-0 pe-3 text-outline transition-colors hover:text-primary"
            onClick={onReveal}
            tabIndex={-1}
          >
            <span className="material-symbols-outlined text-xl">
              {revealed ? 'visibility_off' : 'visibility'}
            </span>
          </button>
        )}
      </span>
      {hint && <span className="mt-1.5 block text-xs text-outline">{hint}</span>}
    </m.label>
  );
}

/** A submit button that answers to the hand — presses down, lifts on hover. */
export function AuthSubmit({ children, busy }: { children: ReactNode; busy?: boolean }) {
  const still = useReducedMotion();
  return (
    <m.button
      variants={rise}
      whileHover={still || busy ? undefined : { y: -1 }}
      whileTap={still || busy ? undefined : { scale: 0.985 }}
      className="btn-primary group relative w-full overflow-hidden py-3"
      disabled={busy}
    >
      {!still && !busy && (
        <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full" />
      )}
      {children}
    </m.button>
  );
}

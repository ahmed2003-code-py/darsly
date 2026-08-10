import type { Config } from 'tailwindcss';

/**
 * Darsly design tokens — hand-tuned "ink & paper" system.
 *
 * ONE accent (iris indigo #4A32C9, from the brand), a warm neutral scale
 * (paper #F7F7F4 / ink #1B1B22 — never pure #000/#fff), a single 12px radius,
 * and hairline 1px borders instead of soft shadows. The legacy Material-style
 * token *names* are kept but re-pointed to this system, so every screen inherits
 * the new look without per-page edits. RTL-first.
 *
 * Every colour resolves through a CSS custom property rather than a literal.
 * That is what lets a teacher's published academy palette repaint the console at
 * runtime: the API derives a token set, the browser sets the variables on the
 * root element, and every existing utility class follows. The literals now live
 * once, in `index.css`, as the platform default — so an academy that has never
 * published looks exactly as it always did.
 *
 * The `<alpha-value>` placeholder is what keeps `bg-primary/50` and friends
 * working; without it, opacity modifiers would silently do nothing.
 */
const c = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const accent = {
  50: c('accent-50'),
  100: c('accent-100'),
  200: c('accent-200'),
  300: c('accent-300'),
  400: c('accent-400'),
  500: c('accent-500'),
  600: c('accent-600'), // primary action
  700: c('accent-700'),
  800: c('accent-800'),
  900: c('accent-900'),
};

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent, // full scale available as accent-50..900

        primary: c('primary'),
        'on-primary': c('on-primary'),
        'primary-container': c('primary-container'),
        'on-primary-container': c('on-primary-container'),
        'inverse-primary': c('inverse-primary'),
        // The hover partner for a filled primary control. It is a token rather
        // than `accent-700` because "darker" is only right on a light palette —
        // on a dark one the button would recede into the page on hover.
        'primary-hover': c('primary-hover'),
        // Tinted chip/active-state background + its readable ink.
        'primary-fixed': c('primary-fixed'),
        'primary-fixed-dim': c('primary-fixed-dim'),
        'on-primary-fixed': c('on-primary-fixed'),
        'on-primary-fixed-variant': c('on-primary-fixed-variant'),

        // Secondary is NOT a second accent — it's a neutral role.
        secondary: c('secondary'),
        'on-secondary': c('on-secondary'),
        'secondary-container': c('secondary-container'),
        'on-secondary-container': c('on-secondary-container'),
        'secondary-fixed': c('secondary-fixed'),
        'secondary-fixed-dim': c('secondary-fixed-dim'),
        'on-secondary-fixed': c('on-secondary-fixed'),
        'on-secondary-fixed-variant': c('on-secondary-fixed-variant'),

        tertiary: c('tertiary'),
        'on-tertiary': c('on-tertiary'),
        'tertiary-container': c('tertiary-container'),
        'on-tertiary-container': c('on-tertiary-container'),

        error: c('error'),
        'on-error': c('on-error'),
        'error-container': c('error-container'),
        'on-error-container': c('on-error-container'),

        // Warm ink & paper surfaces.
        surface: c('surface'),
        'surface-dim': c('surface-dim'),
        'surface-bright': c('surface-bright'),
        'surface-container-lowest': c('surface-container-lowest'),
        'surface-container-low': c('surface-container-low'),
        'surface-container': c('surface-container'),
        'surface-container-high': c('surface-container-high'),
        'surface-container-highest': c('surface-container-highest'),
        'surface-variant': c('surface-variant'),
        'surface-tint': c('surface-tint'),
        'on-surface': c('on-surface'),
        'on-surface-variant': c('on-surface-variant'),
        'inverse-surface': c('inverse-surface'),
        'inverse-on-surface': c('inverse-on-surface'),

        // Muted ink for icons/labels; hairline for 1px borders. The translucent
        // pair is drawn from `--c-line`, which follows the ink — so the same rule
        // gives a dark hairline on paper and a light one on a dark palette.
        outline: c('outline'),
        'outline-variant': 'rgb(var(--c-line) / 0.10)',
        hairline: 'rgb(var(--c-line) / 0.08)',

        background: c('background'),
        'on-background': c('on-background'),
      },
      fontFamily: {
        // Distinctive Arabic-native pairing (not Tajawal/Inter defaults).
        heading: ['Rubik', 'system-ui', 'sans-serif'],
        body: ['"IBM Plex Sans Arabic"', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        tightest: '-0.03em',
      },
      borderRadius: {
        // ONE radius across the app; rounded-full is the only sanctioned
        // exception (pills / avatars).
        none: '0',
        sm: '12px',
        DEFAULT: '12px',
        md: '12px',
        lg: '12px',
        xl: '12px',
        '2xl': '12px',
        '3xl': '16px', // large hero/feature panels only
        full: '9999px',
      },
      boxShadow: {
        // Default separation is a 1px hairline, not a shadow.
        card: '0 0 0 1px rgb(var(--c-shadow) / 0.06)',
        // The only two "real" shadows — reserved for popovers/modals & hover lift.
        elevated: '0 8px 24px -12px rgb(var(--c-shadow) / 0.18)',
        modal: '0 24px 60px -24px rgb(var(--c-shadow) / 0.30)',
        glow: '0 8px 22px -10px rgb(var(--c-primary) / 0.45)',
        hairline: '0 0 0 1px rgb(var(--c-shadow) / 0.08)',
      },
      maxWidth: {
        container: '1200px',
      },
      transitionTimingFunction: {
        // easeOutExpo-ish — the single motion curve used everywhere.
        premium: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;

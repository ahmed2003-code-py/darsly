import type { Config } from 'tailwindcss';

/**
 * Darsly design tokens — hand-tuned "ink & paper" system.
 *
 * ONE accent (iris indigo #4A32C9, from the brand), a warm neutral scale
 * (paper #F7F7F4 / ink #1B1B22 — never pure #000/#fff), a single 12px radius,
 * and hairline 1px borders instead of soft shadows. The legacy Material-style
 * token *names* are kept but re-pointed to this system, so every screen inherits
 * the new look without per-page edits. RTL-first.
 */
const accent = {
  50: '#EFEDFB',
  100: '#DED9F6',
  200: '#BFB6EE',
  300: '#9C8FE2',
  400: '#7863D4',
  500: '#5A44CB',
  600: '#4A32C9', // primary action
  700: '#3C289F',
  800: '#2E1F79',
  900: '#221759',
};

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent, // full scale available as accent-50..900

        primary: accent[600],
        'on-primary': '#ffffff',
        'primary-container': accent[500],
        'on-primary-container': '#ffffff',
        'inverse-primary': accent[300],
        // Tinted chip/active-state background + its readable ink.
        'primary-fixed': '#EBE8FA',
        'primary-fixed-dim': '#D7D1F4',
        'on-primary-fixed': accent[900],
        'on-primary-fixed-variant': accent[700],

        // Secondary is NOT a second accent — it's a neutral role.
        secondary: '#3F3E47',
        'on-secondary': '#ffffff',
        'secondary-container': '#EBE8FA',
        'on-secondary-container': accent[700],
        'secondary-fixed': '#EBE8FA',
        'secondary-fixed-dim': '#D7D1F4',
        'on-secondary-fixed': accent[900],
        'on-secondary-fixed-variant': accent[700],

        tertiary: '#4A4A52',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#E7E6E0',
        'on-tertiary-container': '#3F3E47',

        error: '#BB3B2E',
        'on-error': '#ffffff',
        'error-container': '#F6E1DE',
        'on-error-container': '#7A241C',

        // Warm ink & paper surfaces.
        surface: '#F7F7F4',
        'surface-dim': '#ECEBE6',
        'surface-bright': '#FDFDFB',
        'surface-container-lowest': '#FDFDFB',
        'surface-container-low': '#F2F1EC',
        'surface-container': '#ECEBE6',
        'surface-container-high': '#E6E5DE',
        'surface-container-highest': '#DFDED6',
        'surface-variant': '#ECEBE6',
        'surface-tint': accent[600],
        'on-surface': '#1B1B22',
        'on-surface-variant': '#57565F',
        'inverse-surface': '#26262E',
        'inverse-on-surface': '#F4F3EF',

        // Muted ink for icons/labels; hairline for 1px borders.
        outline: '#87868F',
        'outline-variant': 'rgba(24, 24, 34, 0.10)',
        hairline: 'rgba(24, 24, 34, 0.08)',

        background: '#F7F7F4',
        'on-background': '#1B1B22',
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
        card: '0 0 0 1px rgba(24, 24, 34, 0.06)',
        // The only two "real" shadows — reserved for popovers/modals & hover lift.
        elevated: '0 8px 24px -12px rgba(24, 24, 34, 0.18)',
        modal: '0 24px 60px -24px rgba(24, 24, 34, 0.30)',
        glow: '0 8px 22px -10px rgba(74, 50, 201, 0.45)',
        hairline: '0 0 0 1px rgba(24, 24, 34, 0.08)',
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

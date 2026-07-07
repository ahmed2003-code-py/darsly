import type { Config } from 'tailwindcss';

/**
 * Darsly design tokens — extracted verbatim from the authoritative design
 * reference (hessa_design_system/DESIGN.md, rebranded to Darsly).
 * Identity: deep indigo (wisdom/stability) + fresh teal (progress/success)
 * on layered off-white surfaces. RTL-first.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#422ec7',
        'on-primary': '#ffffff',
        'primary-container': '#5b4ce0',
        'on-primary-container': '#e3deff',
        'inverse-primary': '#c5c0ff',
        'primary-fixed': '#e3dfff',
        'primary-fixed-dim': '#c5c0ff',
        'on-primary-fixed': '#140067',
        'on-primary-fixed-variant': '#3c26c2',
        secondary: '#006b5f',
        'on-secondary': '#ffffff',
        'secondary-container': '#62fae3',
        'on-secondary-container': '#007165',
        'secondary-fixed': '#62fae3',
        'secondary-fixed-dim': '#3cddc7',
        'on-secondary-fixed': '#00201c',
        'on-secondary-fixed-variant': '#005047',
        accent: '#2dd4bf', // fresh teal CTA/progress accent
        tertiary: '#4a4d4f',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#626567',
        'on-tertiary-container': '#e0e2e4',
        error: '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',
        surface: '#f9f9ff',
        'surface-dim': '#cfdaf2',
        'surface-bright': '#f9f9ff',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f0f3ff',
        'surface-container': '#e7eeff',
        'surface-container-high': '#dee8ff',
        'surface-container-highest': '#d8e3fb',
        'surface-variant': '#d8e3fb',
        'surface-tint': '#5545da',
        'on-surface': '#111c2d',
        'on-surface-variant': '#474555',
        'inverse-surface': '#263143',
        'inverse-on-surface': '#ecf1ff',
        outline: '#787586',
        'outline-variant': '#c8c4d7',
        background: '#f9f9ff',
        'on-background': '#111c2d',
      },
      fontFamily: {
        // Arabic-first: Cairo for headings, Tajawal for body (per design doc)
        heading: ['Cairo', 'Plus Jakarta Sans', 'sans-serif'],
        body: ['Tajawal', 'IBM Plex Sans Arabic', 'sans-serif'],
      },
      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.5rem',
        md: '0.75rem',
        lg: '1rem', // buttons & inputs
        xl: '1.5rem', // cards
      },
      boxShadow: {
        // Level 1: cards — 4% indigo tint, 20px blur, 4px Y
        card: '0 4px 20px rgba(66, 46, 199, 0.04)',
        // Level 2: modals/popovers — 12% indigo tint, 40px blur, 10px Y
        modal: '0 10px 40px rgba(66, 46, 199, 0.12)',
      },
      maxWidth: {
        container: '1280px',
      },
    },
  },
  plugins: [],
} satisfies Config;

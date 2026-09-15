import { useEffect, useState } from 'react';
import { DEFAULT_LAYOUT, LayoutStyles } from './studio';

/**
 * What shape the theme has asked the shell to take, as React sees it.
 *
 * The theme writes `data-s-*` attributes on `<html>` (see `studio.ts`); this
 * reads them back and re-renders when they change. Reading the DOM rather than
 * subscribing to the studio module keeps the shell ignorant of where a layout
 * came from — a bought theme, a live preview and a cached copy on boot all
 * arrive the same way, and the shell does not have to know the difference.
 *
 * Absent attribute means default, which means the app as it is today. That is
 * the rule that keeps every existing screen identical for a student who has
 * changed nothing — and for every teacher and admin, whose shell reads these
 * too and finds nothing there.
 */
export interface ShellLayout extends LayoutStyles {
  motion: string;
  cardLayout: string;
  typeScale: string;
}

const DEFAULT: ShellLayout = {
  ...DEFAULT_LAYOUT,
  motion: 'subtle',
  cardLayout: 'grid',
  typeScale: 'default',
};

function read(): ShellLayout {
  if (typeof document === 'undefined') return DEFAULT;
  const r = document.documentElement;
  const a = (name: string) => r.getAttribute(`data-s-${name}`);
  const d = DEFAULT_LAYOUT;
  return {
    nav: {
      desktop: a('nav-desktop') ?? d.nav.desktop,
      tablet: a('nav-tablet') ?? d.nav.tablet,
      mobile: a('nav-mobile') ?? d.nav.mobile,
      labels: a('nav-labels') !== 'off',
      active: a('nav-active') ?? d.nav.active,
    },
    header: {
      variant: a('header') ?? d.header.variant,
      sticky: a('header-sticky') !== 'off',
    },
    footer: a('footer') ?? d.footer,
    density: a('density') ?? d.density,
    width: a('width') ?? d.width,
    motion: a('motion') ?? 'subtle',
    cardLayout: a('card-layout') ?? 'grid',
    typeScale: a('type') ?? 'default',
  };
}

export function useThemeLayout(): ShellLayout {
  const [layout, setLayout] = useState<ShellLayout>(read);
  useEffect(() => {
    // One observer, attribute changes only, on one element: cheap enough to
    // leave running for the life of the app.
    const obs = new MutationObserver((muts) => {
      if (muts.some((m) => m.attributeName?.startsWith('data-s-'))) setLayout(read());
    });
    obs.observe(document.documentElement, { attributes: true });
    setLayout(read());
    return () => obs.disconnect();
  }, []);
  return layout;
}

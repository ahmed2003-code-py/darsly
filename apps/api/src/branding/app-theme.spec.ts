import { contrastRatio } from '../academy-site/renderer/color.util';
import {
  AppTheme,
  brandTokensFromTheme,
  deriveAppTheme,
  paletteFromBrandTokens,
  paletteFromDocumentTheme,
} from './app-theme';

/**
 * The console repainted in a teacher's colours.
 *
 * The risk here is not that it looks wrong — it is that it stops being readable.
 * A palette is chosen for a landing page, where one bold colour and a lot of
 * white space is a virtue; the console is dense, and a teacher sits in it for
 * hours. So most of what follows is contrast, on palettes picked to be awkward
 * rather than pretty.
 */

const rgb = (t: AppTheme, name: string) => {
  const v = t.tokens[`--c-${name}`];
  if (!v) throw new Error(`no token ${name}`);
  return v;
};

/** Tokens are stored as "R G B" triples; tests read them back as hex. */
const hexOf = (t: AppTheme, name: string) =>
  '#' + rgb(t, name).split(' ').map((n) => Number(n).toString(16).padStart(2, '0')).join('');

const ratio = (t: AppTheme, fg: string, bg: string) => contrastRatio(hexOf(t, fg), hexOf(t, bg));

const LIGHT = {
  background: '#FFFDF7', ink: '#1A1A1A', surface: '#F3EFE4', surfaceAlt: '#EAE4D5',
  primary: '#B4531F', accent: '#3F6B4A', mode: 'light',
};
const DARK = {
  background: '#0E1116', ink: '#E8EAF0', surface: '#161A21', surfaceAlt: '#1E232C',
  primary: '#5EE0C0', accent: '#8B7CF6', mode: 'dark',
};

describe('every surface that carries text stays readable', () => {
  for (const [name, palette] of [['a light palette', LIGHT], ['a dark palette', DARK]] as const) {
    describe(name, () => {
      const t = deriveAppTheme(palette);

      it('sets body text well past the AA minimum', () => {
        // Body copy is held to AAA: this is a tool people work in all day, not a
        // page they skim once.
        expect(ratio(t, 'on-background', 'background')).toBeGreaterThanOrEqual(7);
        expect(ratio(t, 'on-surface', 'surface')).toBeGreaterThanOrEqual(7);
      });

      it('keeps muted labels legible rather than decorative', () => {
        expect(ratio(t, 'on-surface-variant', 'background')).toBeGreaterThanOrEqual(4.5);
      });

      it('keeps text on every filled control legible', () => {
        expect(ratio(t, 'on-primary', 'primary')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-secondary', 'secondary')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-tertiary', 'tertiary')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-error', 'error')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-brand-accent', 'brand-accent')).toBeGreaterThanOrEqual(4.5);
      });

      it('keeps text on tinted chips legible', () => {
        expect(ratio(t, 'on-primary-fixed', 'primary-fixed')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-secondary-container', 'secondary-container')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-error-container', 'error-container')).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t, 'on-tertiary-container', 'tertiary-container')).toBeGreaterThanOrEqual(4.5);
      });

      it('draws borders strongly enough to be seen', () => {
        expect(ratio(t, 'outline', 'background')).toBeGreaterThanOrEqual(3);
      });

      it('separates panels from the page, so a card has an edge', () => {
        expect(ratio(t, 'surface-container', 'background')).toBeGreaterThan(1.02);
        expect(ratio(t, 'surface-container-high', 'background')).toBeGreaterThan(1.02);
      });
    });
  }
});

describe('panels step toward the ink, so one rule serves both modes', () => {
  it('darkens panels on a light palette', () => {
    const t = deriveAppTheme(LIGHT);
    expect(contrastRatio(hexOf(t, 'surface-container'), '#ffffff')).toBeGreaterThan(
      contrastRatio(hexOf(t, 'background'), '#ffffff'),
    );
  });

  it('lightens panels on a dark palette', () => {
    // The same expression, inverted: a rule that hard-coded "darker" would be
    // right in light and invisible in dark.
    const t = deriveAppTheme(DARK);
    expect(contrastRatio(hexOf(t, 'surface-container'), '#000000')).toBeGreaterThan(
      contrastRatio(hexOf(t, 'background'), '#000000'),
    );
  });

  it('brightens the primary hover on a dark palette instead of darkening it', () => {
    // Darkening a hover state on a dark page walks it into the background, so
    // the button appears to stop responding.
    const dark = deriveAppTheme(DARK);
    expect(contrastRatio(hexOf(dark, 'primary-hover'), hexOf(dark, 'background'))).toBeGreaterThan(
      contrastRatio(hexOf(dark, 'primary'), hexOf(dark, 'background')),
    );
    const light = deriveAppTheme(LIGHT);
    expect(contrastRatio(hexOf(light, 'primary-hover'), '#ffffff')).toBeGreaterThan(
      contrastRatio(hexOf(light, 'primary'), '#ffffff'),
    );
  });
});

describe('the mode is measured, not believed', () => {
  it('reads a dark background as dark however it is labelled', () => {
    // `mode` records what the model thought it built. Trusting it would let a
    // mislabelled palette put dark text on a dark page.
    expect(deriveAppTheme({ ...DARK, mode: 'light' }).mode).toBe('dark');
  });

  it('reads a light background as light however it is labelled', () => {
    expect(deriveAppTheme({ ...LIGHT, mode: 'dark' }).mode).toBe('light');
  });

  it('flips hairlines with the mode so a line on a dark page is a light line', () => {
    // Hairlines are drawn as an alpha of `line`; following the ink is what makes
    // the same rule produce a dark line on paper and a light one on ink.
    const light = deriveAppTheme(LIGHT);
    const dark = deriveAppTheme(DARK);
    expect(contrastRatio(hexOf(light, 'line'), '#ffffff')).toBeGreaterThan(4);
    expect(contrastRatio(hexOf(dark, 'line'), '#000000')).toBeGreaterThan(4);
  });

  it('keeps shadows black on a dark palette rather than tinting them with light ink', () => {
    expect(hexOf(deriveAppTheme(DARK), 'shadow')).toBe('#000000');
  });
});

describe('palettes that would break the console are repaired, not rejected', () => {
  it('rescues ink that the palette set too close to its background', () => {
    // A teacher's page can carry grey-on-grey as a stylistic choice. A table of
    // fifty rows cannot.
    const t = deriveAppTheme({ background: '#7A7A7A', ink: '#8A8A8A', primary: '#7F7F7F' });
    expect(ratio(t, 'on-background', 'background')).toBeGreaterThanOrEqual(7);
  });

  it('moves a mid-tone background, because no ink can rescue one', () => {
    // Against mid grey the best contrast any colour achieves is under 5:1, so
    // this is the one repair that has to move the background rather than the
    // text — and it moves it toward the pole its own mode implies, keeping a
    // light palette light.
    const light = deriveAppTheme({ background: '#7A7A7A', ink: '#8A8A8A' });
    expect(hexOf(light, 'background')).not.toBe('#7a7a7a');
    expect(light.mode).toBe('dark');
    expect(contrastRatio(hexOf(light, 'background'), '#000000')).toBeLessThan(
      contrastRatio('#7A7A7A', '#000000'),
    );
  });

  it('leaves a background alone when readable text already exists on it', () => {
    // The repair is a floor, not a preference: a palette that works is published
    // as the teacher approved it.
    expect(hexOf(deriveAppTheme(LIGHT), 'background')).toBe(LIGHT.background.toLowerCase());
    expect(hexOf(deriveAppTheme(DARK), 'background')).toBe(DARK.background.toLowerCase());
  });

  it('keeps danger distinguishable from a warm brand', () => {
    // A terracotta academy would otherwise get "Delete" and "Publish" in nearly
    // the same colour — the one colour confusion in a console that costs work.
    const warm = deriveAppTheme({ ...LIGHT, primary: '#B4531F' });
    expect(hexOf(warm, 'error')).not.toBe(hexOf(warm, 'primary'));
    expect(contrastRatio(hexOf(warm, 'error'), hexOf(warm, 'primary'))).toBeGreaterThan(1.6);
    // Still legible, and still recognisably a warning rather than a new hue.
    expect(ratio(warm, 'error', 'background')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(warm, 'on-error', 'error')).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves the danger colour alone when the brand is nowhere near it', () => {
    // The rule is a collision guard, not a preference: an indigo or green brand
    // keeps the platform red.
    expect(hexOf(deriveAppTheme({ ...LIGHT, primary: '#4A32C9' }), 'error')).toBe('#bb3b2e');
  });

  it('keeps a danger colour visible on a dark page', () => {
    // The platform red is tuned for paper and all but disappears on ink, and an
    // unreadable error is worse than none.
    const t = deriveAppTheme(DARK);
    expect(ratio(t, 'error', 'background')).toBeGreaterThanOrEqual(4.5);
  });

  it('ignores a card colour that does not separate from the page', () => {
    // A surface equal to the background is a card with no edges — the commonest
    // way these palettes arrive, since a page can carry it and a console cannot.
    const t = deriveAppTheme({ ...LIGHT, surface: LIGHT.background });
    expect(contrastRatio(hexOf(t, 'surface-container'), LIGHT.background)).toBeGreaterThan(1.02);
  });

  it('survives a palette of pure black on pure white', () => {
    const t = deriveAppTheme({ background: '#FFFFFF', ink: '#000000', primary: '#000000' });
    expect(ratio(t, 'on-primary', 'primary')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, 'on-background', 'background')).toBeGreaterThanOrEqual(7);
  });

  it('survives a palette of pure white on pure black', () => {
    const t = deriveAppTheme({ background: '#000000', ink: '#FFFFFF', primary: '#FFFFFF' });
    expect(ratio(t, 'on-primary', 'primary')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t, 'outline', 'background')).toBeGreaterThanOrEqual(3);
  });

  it('falls back field by field rather than discarding the whole palette', () => {
    // These arrive as model-authored JSON out of the database, so a single bad
    // field must not cost the teacher the colour they did choose.
    const t = deriveAppTheme({ primary: '#B4531F', background: 'not-a-colour', ink: '' });
    expect(hexOf(t, 'primary')).toBe('#b4531f');
    expect(hexOf(t, 'background')).toBe('#f7f7f4');
  });

  it('returns the platform theme for junk, an empty object and null alike', () => {
    for (const input of [null, undefined, {}, { primary: 'rgb(1,2,3)' } as never]) {
      const t = deriveAppTheme(input);
      expect(hexOf(t, 'primary')).toBe('#4a32c9');
      expect(t.mode).toBe('light');
    }
  });
});

describe('the brand ramp keeps the meaning the platform scale had', () => {
  const t = deriveAppTheme(LIGHT);

  it('puts the primary action at 600, where every existing class expects it', () => {
    expect(hexOf(t, 'accent-600')).toBe(LIGHT.primary.toLowerCase());
  });

  it('runs light to dark across the scale', () => {
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]
      .map((s) => contrastRatio(hexOf(t, `accent-${s}`), '#000000'));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
  });

  it('emits every token as an "R G B" triple the stylesheet can consume', () => {
    for (const [name, value] of Object.entries(t.tokens)) {
      expect(name).toMatch(/^--c-[a-z0-9-]+$/);
      expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });
});

describe('reading the palette off a published document', () => {
  it('prefers the composed design system when a document has one', () => {
    const p = paletteFromDocumentTheme({
      primary: '#111111',
      designSpec: { palette: { ...DARK } },
    });
    expect(p).toMatchObject({ background: DARK.background, primary: DARK.primary });
  });

  it('reads the older three-colour block, taking the brand pair from the theme', () => {
    const p = paletteFromDocumentTheme({
      primary: '#B4531F',
      accent: '#3F6B4A',
      design: { background: '#FFFDF7', ink: '#1A1A1A', surface: '#F3EFE4' },
    });
    expect(p).toMatchObject({ background: '#FFFDF7', primary: '#B4531F', accent: '#3F6B4A' });
  });

  it('still yields the brand pair for a document with no design system at all', () => {
    expect(paletteFromDocumentTheme({ primary: '#B4531F' })).toMatchObject({ primary: '#B4531F' });
  });

  it('yields nothing for a theme that carries no colour', () => {
    expect(paletteFromDocumentTheme({})).toBeNull();
    expect(paletteFromDocumentTheme(null)).toBeNull();
  });
});

describe('what a publish records on the academy', () => {
  it('records the palette of a site composed by the current pipeline', () => {
    // The regression this exists for: publish used to read `theme.design`, which
    // v3 documents do not have. Every site the composition pipeline produced
    // therefore recorded nothing, and publishing left the console on the
    // platform palette — the feature looked wired up and did nothing.
    const stored = brandTokensFromTheme({
      primary: DARK.primary,
      accent: DARK.accent,
      designSpec: { palette: { ...DARK }, geometry: { radius: 18 }, rhythm: { density: 'airy' } },
    });
    expect(stored).not.toBeNull();
    expect(stored!.palette).toMatchObject({ background: DARK.background, mode: 'dark' });
    // The flat fields the storefront already reads come along, mapped from where
    // v3 keeps the same ideas.
    expect(stored).toMatchObject({ background: DARK.background, radius: 18, density: 'airy' });
  });

  it('keeps recording what an older document recorded', () => {
    const design = {
      background: '#FFFDF7', ink: '#1A1A1A', surface: '#F3EFE4',
      radius: 8, density: 'regular', headingScale: 'balanced', heroTreatment: 'flat',
    };
    const stored = brandTokensFromTheme({ primary: '#B4531F', accent: '#3F6B4A', design });
    expect(stored).toMatchObject(design);
    expect(stored!.palette).toMatchObject({ primary: '#B4531F', background: '#FFFDF7' });
  });

  it('records nothing for a document with no colour at all', () => {
    expect(brandTokensFromTheme({})).toBeNull();
  });

  it('round-trips: what publish stores is what the console derives from', () => {
    // The two halves are written apart — one at publish, one at read — so this
    // pins the seam between them.
    const stored = brandTokensFromTheme({ primary: LIGHT.primary, designSpec: { palette: { ...LIGHT } } });
    const theme = deriveAppTheme(paletteFromBrandTokens(stored, '#000000', '#000000'));
    expect(hexOf(theme, 'primary')).toBe(LIGHT.primary.toLowerCase());
    expect(hexOf(theme, 'background')).toBe(LIGHT.background.toLowerCase());
  });

  it('falls back to the brand columns for an academy that never published a design', () => {
    // Set in the academy console by hand rather than by the Studio: still a
    // choice the teacher made, and still better than the platform indigo.
    const theme = deriveAppTheme(paletteFromBrandTokens(null, '#B4531F', '#3F6B4A'));
    expect(hexOf(theme, 'primary')).toBe('#b4531f');
    expect(ratio(theme, 'on-primary', 'primary')).toBeGreaterThanOrEqual(4.5);
  });

  it('leaves the platform palette in place when there is nothing at all', () => {
    expect(hexOf(deriveAppTheme(paletteFromBrandTokens(null, null, null)), 'primary')).toBe('#4a32c9');
  });
});

import {
  BACKDROPS, DENSITIES, DesignFingerprint, DesignSpec, HEADING_FAMILIES, TYPE_SCALES,
} from '../schema/design-spec';
import { SiteBlock } from '../schema/site-document';
import { lighten, darken, relLuminance } from '../renderer/color.util';
import { patternsFor } from '../renderer/compose';
import { RulesVerdict } from './contracts';
import { MIN_DIVERGENCE, divergence, fingerprint } from './fingerprint';

/**
 * The deterministic guarantee behind "regenerate and get something different".
 *
 * The prompt asks the model to change at least three axes. This is what happens
 * when it does not. It rotates the smallest set of axes needed to clear the
 * threshold, choosing each replacement by walking a list at an index derived
 * from how many times the teacher has already regenerated — so the result is
 * deterministic, reproducible, and different every time round.
 *
 * It deliberately does not touch the palette hues or the section order. Those
 * carry the teacher's brand and their argument; a regeneration should be a
 * redesign, not a rebrand.
 */

const rotate = <T>(list: readonly T[], current: T, step: number): T => {
  const i = list.indexOf(current);
  const from = i < 0 ? 0 : i;
  return list[(from + Math.max(1, step)) % list.length];
};

export interface DivergenceResult {
  design: DesignSpec;
  blocks: SiteBlock[];
  verdicts: RulesVerdict[];
}

/**
 * Force a design far enough away from the ones this academy has already seen.
 *
 * `step` is the regeneration count: it makes the rotation walk forward rather
 * than landing on the same "different" answer every time.
 */
export function enforceDivergence(
  design: DesignSpec,
  blocks: SiteBlock[],
  recent: DesignFingerprint[],
  step: number,
): DivergenceResult {
  const verdicts: RulesVerdict[] = [];
  if (!recent.length) return { design, blocks, verdicts };

  const current = fingerprint(design, { blocks });
  const closest = recent.reduce(
    (worst, f) => (divergence(current, f) < divergence(current, worst) ? f : worst),
    recent[0],
  );
  if (divergence(current, closest) >= MIN_DIVERGENCE) return { design, blocks, verdicts };

  const d: DesignSpec = structuredClone(design);
  const nextBlocks = blocks.map((b) => ({ ...b }));
  const changed: string[] = [];

  // Ordered by how visible the change is, so the smallest number of rotations
  // buys the largest perceived difference.
  const axes: { name: string; differs: boolean; apply: () => void }[] = [
    {
      name: 'palette mode',
      differs: current.mode !== closest.mode,
      apply: () => {
        // Invert the page rather than recolour it: the single most noticeable
        // change available, and it keeps the brand hues intact.
        const light = relLuminance(d.palette.background) > 0.5;
        d.palette.background = light ? '#0E1016' : '#FBFAF7';
        d.palette.ink = light ? '#ECEEF5' : '#16181F';
        d.palette.surface = light ? '#161A22' : '#F2F1EC';
        d.palette.surfaceAlt = light ? '#1D222C' : '#E9E7E0';
        d.palette.accent = light ? lighten(d.palette.accent, 0.3) : darken(d.palette.accent, 0.15);
        d.palette.mode = light ? 'dark' : 'light';
      },
    },
    {
      name: 'backdrop',
      differs: current.backdrop !== closest.backdrop,
      apply: () => { d.decoration.backdrop = rotate(BACKDROPS, d.decoration.backdrop, step + 1); },
    },
    {
      name: 'heading typeface',
      differs: current.headingFamily !== closest.headingFamily,
      apply: () => { d.typography.headingFamily = rotate(HEADING_FAMILIES, d.typography.headingFamily, step + 1); },
    },
    {
      name: 'hero pattern',
      differs: current.heroPattern !== closest.heroPattern,
      apply: () => {
        const heroes = patternsFor('hero').map((p) => p.id);
        const hero = nextBlocks.find((b) => b.type === 'hero');
        if (!hero || !heroes.length) return;
        const next = rotate(heroes, hero.section?.pattern ?? heroes[0], step + 1);
        hero.section = { ...(hero.section ?? { pattern: next }), pattern: next };
      },
    },
    {
      name: 'type scale',
      differs: current.scale !== closest.scale,
      apply: () => { d.typography.scale = rotate(TYPE_SCALES, d.typography.scale, step + 1); },
    },
    {
      name: 'density',
      differs: current.densityBand !== closest.densityBand,
      apply: () => { d.rhythm.density = rotate(DENSITIES, d.rhythm.density, step + 1); },
    },
    {
      name: 'radius',
      differs: current.radiusBand !== closest.radiusBand,
      apply: () => {
        const bands = [2, 14, 28];
        const now = d.geometry.radius;
        d.geometry.radius = bands[(bands.findIndex((b) => Math.abs(b - now) < 7) + 1 + step) % bands.length];
      },
    },
  ];

  let score = divergence(current, closest);
  for (const axis of axes) {
    if (score >= MIN_DIVERGENCE) break;
    if (axis.differs) continue; // already different on this axis
    axis.apply();
    changed.push(axis.name);
    score = divergence(fingerprint(d, { blocks: nextBlocks }), closest);
  }

  if (changed.length) {
    verdicts.push({
      code: 'divergence-enforced',
      severity: 'warn',
      message: `the design repeated a recent one; ${changed.join(', ')} ${changed.length === 1 ? 'was' : 'were'} rotated to make it a redesign rather than a recolour`,
      target: 'design',
    });
  }
  return { design: d, blocks: nextBlocks, verdicts };
}

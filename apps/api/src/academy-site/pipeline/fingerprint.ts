import { DesignFingerprint, DesignSpec } from '../schema/design-spec';
import { SiteDocument } from '../schema/site-document';
import { hexToRgb } from '../renderer/color.util';

/**
 * The design fingerprint: what a generation actually looked like, on the axes a
 * visitor would notice.
 *
 * Evolution used to remember a single catalogue key, which made "give me
 * something different" mean "give me a different one of seven". A fingerprint
 * lets the next generation be measured against the last on eight independent
 * axes, so "different" can mean what a teacher means by it.
 */

function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}

const radiusBand = (r: number): DesignFingerprint['radiusBand'] =>
  r <= 6 ? 'sharp' : r <= 18 ? 'moderate' : 'round';

export function fingerprint(design: DesignSpec, doc: Pick<SiteDocument, 'blocks'>): DesignFingerprint {
  const hero = doc.blocks.find((b) => b.type === 'hero');
  return {
    mode: design.palette.mode,
    hue: hueOf(design.palette.primary),
    headingFamily: design.typography.headingFamily,
    scale: design.typography.scale,
    radiusBand: radiusBand(design.geometry.radius),
    densityBand: design.rhythm.density,
    backdrop: design.decoration.backdrop,
    heroPattern: hero?.section?.pattern ?? '',
    sectionOrder: doc.blocks.map((b) => b.type).join(','),
  };
}

/** How many of the noticeable axes two designs differ on. Hue counts at 40°. */
export function divergence(a: DesignFingerprint, b: DesignFingerprint): number {
  let n = 0;
  if (a.mode !== b.mode) n++;
  if (Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue)) >= 40) n++;
  if (a.headingFamily !== b.headingFamily) n++;
  if (a.scale !== b.scale) n++;
  if (a.radiusBand !== b.radiusBand) n++;
  if (a.densityBand !== b.densityBand) n++;
  if (a.backdrop !== b.backdrop) n++;
  if (a.heroPattern !== b.heroPattern) n++;
  if (a.sectionOrder !== b.sectionOrder) n++;
  return n;
}

/** Below this, a regeneration is a recolour rather than a redesign. */
export const MIN_DIVERGENCE = 3;

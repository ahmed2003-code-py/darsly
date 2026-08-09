import { DesignSpec } from '../schema/design-spec';
import { contrastRatio } from '../renderer/color.util';
import { TECHNICAL_DESIGN, WARM_DESIGN } from '../__fixtures__/composition.fixture';
import { repairDesign } from './design-repair';

/**
 * Repair, never reject.
 *
 * A model asked for thirty design decisions will occasionally get one wrong.
 * Throwing away an otherwise good page because its body text is a shade too dark
 * costs a generation, costs money and gives the teacher nothing — so every rule
 * corrects and explains rather than failing.
 *
 * These tests are written as "what happens to a bad design", not "is it
 * rejected", because nothing here is ever rejected.
 */

const base = (over: Partial<DesignSpec> = {}): DesignSpec => ({
  ...structuredClone(WARM_DESIGN),
  ...over,
});

const withPalette = (p: Partial<DesignSpec['palette']>) => {
  const d = structuredClone(WARM_DESIGN);
  d.palette = { ...d.palette, ...p };
  return d;
};

const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe('repairDesign — colour', () => {
  it('leaves a competent palette exactly as it was', () => {
    const { design, verdicts } = repairDesign(structuredClone(TECHNICAL_DESIGN));
    expect(design.palette).toEqual(TECHNICAL_DESIGN.palette);
    expect(codes(verdicts)).toEqual([]);
  });

  it('rescues body text that is illegible on its own background', () => {
    // The single most valuable rule in the system. Nothing checked this before,
    // so a page could — and eventually would — go live effectively blank.
    const { design, verdicts } = repairDesign(withPalette({ background: '#101010', ink: '#141414' }));
    expect(codes(verdicts)).toContain('ink-contrast-raised');
    expect(contrastRatio(design.palette.ink, design.palette.background)).toBeGreaterThanOrEqual(7);
  });

  it('brightens ink on a dark page and darkens it on a light one', () => {
    const dark = repairDesign(withPalette({ background: '#0A0A0A', ink: '#151515' })).design;
    const light = repairDesign(withPalette({ background: '#FAFAFA', ink: '#EFEFEF' })).design;
    expect(contrastRatio(dark.palette.ink, '#000000')).toBeGreaterThan(contrastRatio('#151515', '#000000'));
    expect(contrastRatio(light.palette.ink, '#FFFFFF')).toBeGreaterThan(contrastRatio('#EFEFEF', '#FFFFFF'));
  });

  it('gives a surface an edge when it is identical to the background', () => {
    const { design, verdicts } = repairDesign(withPalette({ background: '#FFFFFF', surface: '#FFFFFF' }));
    expect(codes(verdicts)).toContain('surface-indistinct');
    expect(design.palette.surface).not.toBe('#FFFFFF');
  });

  it('pulls back a surface that reads as a second theme', () => {
    const { design, verdicts } = repairDesign(withPalette({ background: '#FFF9F2', surface: '#101020' }));
    expect(codes(verdicts)).toContain('surface-overpowering');
    expect(contrastRatio(design.palette.surface, design.palette.background)).toBeLessThanOrEqual(2.7);
  });

  it('separates an accent that is nearly, but not exactly, the primary', () => {
    const { design, verdicts } = repairDesign(withPalette({ primary: '#3B82F6', accent: '#3B84F6' }));
    expect(codes(verdicts)).toContain('accent-indistinct');
    expect(design.palette.accent).not.toBe('#3B84F6');
  });

  it('accepts a deliberately monochrome brand', () => {
    const { verdicts } = repairDesign(withPalette({ primary: '#C8A96A', accent: '#C8A96A' }));
    expect(codes(verdicts)).not.toContain('accent-indistinct');
  });

  it('corrects a palette that describes itself wrongly', () => {
    const { design, verdicts } = repairDesign(withPalette({ background: '#0A0A12', mode: 'light' }));
    expect(codes(verdicts)).toContain('mode-corrected');
    expect(design.palette.mode).toBe('dark');
  });

  it('replaces a value that is not a colour at all', () => {
    const { design, verdicts } = repairDesign(withPalette({ primary: 'rebeccapurple' as never }));
    expect(codes(verdicts)).toContain('colour-invalid');
    expect(design.palette.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('repairDesign — type, geometry and motion budgets', () => {
  it('eases type that has every amplifier turned up at once', () => {
    const d = structuredClone(TECHNICAL_DESIGN);
    d.typography = { ...d.typography, scale: 'monumental', headingCase: 'upper', headingFamily: 'condensed', tracking: 'tight' };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('typography-overloaded');
    expect(design.typography.scale).toBe('dramatic');
  });

  it('leaves a monumental headline alone when it is not also shouting', () => {
    const d = structuredClone(WARM_DESIGN);
    d.typography = { ...d.typography, scale: 'monumental' };
    expect(repairDesign(d).design.typography.scale).toBe('monumental');
  });

  it('clamps a radius outside the supported range', () => {
    const d = structuredClone(WARM_DESIGN);
    d.geometry = { ...d.geometry, radius: 900 };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('radius-clamped');
    expect(design.geometry.radius).toBe(32);
  });

  it('gives a hard offset shadow an edge to sit against', () => {
    const d = structuredClone(WARM_DESIGN);
    d.geometry = { ...d.geometry, shadow: 'brutal', border: 'none' };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('brutal-needs-border');
    expect(design.geometry.border).toBe('hairline');
  });

  it('holds the page to three scroll effects', () => {
    const d = structuredClone(WARM_DESIGN);
    d.motion = { intensity: 'lively', entrance: 'rise', scrollFx: ['parallax', 'counters', 'marquee', 'pointer-glow', 'progress-bar', 'sticky-headings'] };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('scrollfx-budget');
    expect(design.motion.scrollFx).toEqual(['parallax', 'counters', 'marquee']);
  });

  it('will not let a cinematic page also parallax and scroll a marquee', () => {
    const d = structuredClone(WARM_DESIGN);
    d.motion = { intensity: 'cinematic', entrance: 'rise', scrollFx: ['parallax', 'marquee'] };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('motion-overloaded');
    expect(design.motion.scrollFx).not.toContain('marquee');
  });

  it('holds the page to three accent marks', () => {
    const d = structuredClone(WARM_DESIGN);
    d.decoration = { ...d.decoration, accents: ['blob', 'ring', 'rule-lines', 'corner-brackets', 'sticker-badges'] };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('accent-budget');
    expect(design.decoration.accents).toHaveLength(3);
  });

  it('removes film grain from a light page, where it reads as dirt', () => {
    const d = structuredClone(WARM_DESIGN);
    d.geometry = { ...d.geometry, grain: true };
    const { design, verdicts } = repairDesign(d);
    expect(codes(verdicts)).toContain('grain-light-page');
    expect(design.geometry.grain).toBe(false);
  });

  it('keeps film grain on a dark page, where it is texture', () => {
    expect(repairDesign(structuredClone(TECHNICAL_DESIGN)).design.geometry.grain).toBe(true);
  });
});

describe('repairDesign — unknown values', () => {
  it('falls back rather than throwing, whatever it is handed', () => {
    const d = structuredClone(WARM_DESIGN);
    d.decoration = { backdrop: 'lava-lamp' as never, accents: ['sparkles' as never], dividers: 'zigzag' as never, imageTreatment: 'hologram' as never };
    d.motion = { intensity: 'calm', entrance: 'teleport' as never, scrollFx: ['explode' as never] };
    d.typography = { ...d.typography, headingFamily: 'comic' as never };
    const { design, verdicts } = repairDesign(d);
    expect(design.decoration.backdrop).toBe('none');
    expect(design.decoration.accents).toEqual([]);
    expect(design.decoration.dividers).toBe('none');
    expect(design.decoration.imageTreatment).toBe('rounded');
    expect(design.motion.entrance).toBe('rise');
    expect(design.motion.scrollFx).toEqual([]);
    expect(design.typography.headingFamily).toBe('sans');
    expect(verdicts.every((v) => v.severity === 'warn')).toBe(true);
  });

  it('never mutates the design it was given', () => {
    const original = structuredClone(WARM_DESIGN);
    const copy = structuredClone(original);
    repairDesign(copy);
    expect(copy).toEqual(original);
  });

  it('is idempotent — repairing a repaired design changes nothing', () => {
    const once = repairDesign(withPalette({ background: '#101010', ink: '#141414' })).design;
    const twice = repairDesign(structuredClone(once));
    expect(twice.design).toEqual(once);
    expect(twice.verdicts).toEqual([]);
  });
});

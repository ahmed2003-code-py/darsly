/**
 * Deterministic color system: derive a cohesive palette from the brand and
 * reason about legibility. Pure functions, shared by the renderer (to build the
 * CSS) and the Design Rules Engine (to validate contrast). No side effects.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHex(hex: string): boolean {
  return HEX.test(hex);
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(rgb: number[]): string {
  return '#' + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

/** Blend `hex` toward `target` by weight `w` (0..1). */
export function mix(hex: string, target: string, w: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(a.map((c, i) => c + (b[i] - c) * w));
}

export const darken = (hex: string, amt: number) => mix(hex, '#000000', amt);
export const lighten = (hex: string, amt: number) => mix(hex, '#ffffff', amt);

/** WCAG relative luminance (0..1). */
export function relLuminance(hex: string): number {
  const a = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** The legible foreground (near-black / white) to place on top of `hex`. */
export const onColor = (hex: string) => (relLuminance(hex) > 0.5 ? '#12121c' : '#ffffff');

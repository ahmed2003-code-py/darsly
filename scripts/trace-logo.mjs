#!/usr/bin/env node
/**
 * Turn the logo bitmap into a colourable SVG.
 *
 * Hand-drawing a logo from a screenshot gets you something that looks like it
 * until you put the two side by side. The letterforms are the giveaway — the
 * curve of the `y`, the join on the `س`, the tilt of the diacritics — and none
 * of that survives being redrawn by eye. So the paths are traced from the
 * artwork itself, which is exact by construction.
 *
 * The output paints with `currentColor`, so the colour is whatever CSS says:
 * one file serves the purple brand, a white version on a dark header, and a
 * single-colour favicon, with no re-export.
 *
 * Usage:
 *   node scripts/trace-logo.mjs <input.png> <output.svg> [--threshold 200]
 *
 * Input wants the logo on a plain background with nothing else in frame — crop
 * the mockup down to the artwork first. Transparent PNG is ideal.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const [input, output] = argv.slice(2);
const thresholdArg = argv.indexOf('--threshold');
const threshold = thresholdArg > -1 ? Number(argv[thresholdArg + 1]) : 200;

if (!input || !output) {
  console.error('usage: node scripts/trace-logo.mjs <input.png> <output.svg> [--threshold 200]');
  exit(1);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  exit(1);
}

const py = `
import sys, numpy as np, potrace
from PIL import Image

src, dst, threshold = sys.argv[1], sys.argv[2], int(sys.argv[3])

img = Image.open(src)
# Composite onto white first: a transparent PNG has undefined colour where it is
# transparent, and reading those pixels directly traces whatever the exporter
# happened to leave behind.
if img.mode in ('RGBA', 'LA', 'P'):
    img = img.convert('RGBA')
    flat = Image.new('RGBA', img.size, (255, 255, 255, 255))
    flat.alpha_composite(img)
    img = flat
img = img.convert('L')

# Ink is dark, paper is light — and potracer traces the FALSE pixels, not the
# True ones. Getting this backwards does not fail; it silently traces the
# background and hands you the logo as a hole in a rectangle.
ink = np.array(img) < threshold
if not ink.any():
    sys.exit('nothing to trace — try a higher --threshold')
if ink.mean() > 0.9:
    sys.exit('almost everything is ink — try a lower --threshold')
bitmap = ~ink

path = potrace.Bitmap(bitmap).trace(turdsize=2, alphamax=1.0, opticurve=True, opttolerance=0.2)

# potracer hands back point objects, not tuples.
def xy(p):
    return f'{p.x:.2f} {p.y:.2f}'

d = []
for curve in path:
    d.append(f'M{xy(curve.start_point)}')
    for seg in curve:
        if seg.is_corner:
            d.append(f'L{xy(seg.c)}L{xy(seg.end_point)}')
        else:
            d.append(f'C{xy(seg.c1)} {xy(seg.c2)} {xy(seg.end_point)}')
    d.append('Z')

h, w = ink.shape
svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="Darsly">\\n'
    # currentColor is the whole point: the colour comes from CSS, so this one
    # file is the purple logo, the white-on-dark logo and the favicon.
    f'  <path fill="currentColor" fill-rule="evenodd" d="{"".join(d)}"/>\\n'
    f'</svg>\\n'
)
open(dst, 'w').write(svg)
print(f'{dst}  ({w}x{h}, {len(path)} shapes, {len(svg)/1024:.1f} KB)')
`;

const res = spawnSync('python3', ['-c', py, input, output, String(threshold)], { stdio: 'inherit' });
exit(res.status ?? 1);

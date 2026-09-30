import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `.material-symbols-outlined { display: inline-block }` sits after Tailwind's
 * utilities in index.css, so a plain `hidden` on an icon loses and the icon
 * still renders — squeezed to a sliver by its flex row on a phone. An icon
 * that must hide at a width uses the important form (`max-sm:!hidden`).
 */
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
  );

describe('icon visibility', () => {
  it('no icon relies on a plain `hidden` class', () => {
    const offenders: string[] = [];
    for (const f of files(join(__dirname, '..'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /className="([^"]*material-symbols-outlined[^"]*)"/g,
      )) {
        if (/(^|\s)hidden(\s|$)/.test(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The icon rule also sets `direction: ltr` (so a ligature name reads
   * right), and logical insets resolve against an element's OWN direction:
   * `absolute start-3` on an icon meant "left" even in Arabic, parking every
   * search box's magnifier on the wrong side, over the typed text. A
   * positioned icon takes the page's direction for its placement.
   */
  it('an absolutely placed icon with start/end follows the page direction', () => {
    const offenders: string[] = [];
    for (const f of files(join(__dirname, '..'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(
        /className="([^"]*material-symbols-outlined[^"]*)"/g,
      )) {
        const c = m[1];
        if (
          /\babsolute\b/.test(c) &&
          /(^|\s)-?(start|end)-/.test(c) &&
          !c.includes('[direction:inherit]')
        )
          offenders.push(`${f}: ${c}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

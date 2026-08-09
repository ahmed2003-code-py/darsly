import { DesignSpec } from '../../schema/design-spec';
import { ComposePlan } from '../../pipeline/contracts';
import { escapeAttr, escapeHtml, safeUrl } from '../html.util';
import { RenderContext } from '../types';
import { baseCss } from './base';
import { clientJs } from './client';
import {
  ACCENT_CSS, BACKDROP_CSS, DIVIDER_CSS, GRAIN_CSS, IMAGE_CSS, SCROLL_FX_CSS, backdropHtml,
} from './effects';
import { i18n } from './helpers';
import { getPattern } from './registry';
import { fontHref, rootAttrs, tokens } from './tokens';
import { ComposeContext } from './types';
import './patterns';

/**
 * The composition compiler: a resolved plan in, one self-contained HTML document
 * out. Pure and total — it makes no design decisions, and every pattern it is
 * asked for has already been resolved against the registry by the Site Brain.
 *
 * Its one real trick is that it assembles the stylesheet and the script from
 * only the modules the page actually used. A quiet typographic page ships no
 * mosaic CSS, no parallax and no counter animation; the old renderer shipped all
 * of it to every academy whether or not a single section wanted it.
 */
export function composeSite(plan: ComposePlan, ctx: RenderContext): string {
  const design = plan.design;
  const lang = plan.theme?.defaultLang ?? ctx.defaultLang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  // Modules requested while rendering. Sets, so a pattern used five times still
  // contributes its stylesheet once.
  const decor = new Set<string>();
  const effects = new Set<string>();

  const composeCtx: ComposeContext = {
    ...ctx,
    design,
    // Resolved once, here, because only the compiler can see the whole page. No
    // pattern may invent a destination.
    ctaHref: `/t/${encodeURIComponent(ctx.slug)}`,
    useDecor: (id) => decor.add(id),
    useEffect: (id) => effects.add(id),
  };

  const patternCss = new Map<string, string>();
  const body = plan.sections
    .map((s) => {
      const pattern = getPattern(s.spec.pattern);
      if (!pattern) return '';
      const html = pattern.render(s.block, s.spec, composeCtx);
      if (!html) return '';
      if (!patternCss.has(pattern.id)) patternCss.set(pattern.id, pattern.css());
      for (const id of pattern.js ?? []) effects.add(id);
      return html;
    })
    .filter(Boolean)
    .join('\n');

  // Chrome behaviours the page always wants.
  effects.add('sticky-nav');
  if (design.motion.scrollFx.includes('progress-bar')) effects.add('progress-bar');
  if (design.motion.scrollFx.includes('parallax')) effects.add('parallax');
  if (design.motion.scrollFx.includes('counters')) effects.add('counters');
  if (design.motion.scrollFx.includes('pointer-glow')) effects.add('pointer-glow');
  if (design.motion.scrollFx.includes('marquee')) effects.add('marquee');

  const brand = escapeHtml(brandFor(lang, ctx.academyName, ctx.ownerName));
  const title = escapeHtml(plan.seo?.title?.[lang]?.trim() || brandFor(lang, ctx.academyName, ctx.ownerName));
  const description = plan.seo?.description?.[lang]?.trim();

  const css = [
    tokens(design),
    baseCss(),
    ...decorationCss(design, decor),
    ...[...patternCss.values()],
  ].join('\n');

  const progressBar = design.motion.scrollFx.includes('progress-bar')
    ? '<div class="scroll-bar" aria-hidden="true"><i></i></div>'
    : '';

  return `<!--
  target="_top" is load-bearing, not decoration.

  The app embeds this page in a full-viewport iframe, so a link without it
  navigates the FRAME while the browser's address bar keeps pointing at
  /a/<slug>. Everything after that — signing in, the course, the whole console —
  happens inside the frame at a URL nobody can see or bookmark, and the first
  refresh throws the visitor back to this marketing page.

  In-page anchors (#top, #courses) deliberately stay in the frame: sending those
  to _top would navigate the parent window to this raw HTML.
-->
<!doctype html>
<html lang="${lang}" dir="${dir}" ${rootAttrs(design)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${description ? `\n<meta name="description" content="${escapeAttr(description)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${escapeAttr(fontHref(design))}" rel="stylesheet">
<style>${css}</style>
</head>
<body>
${backdropHtml(design.decoration.backdrop)}${design.geometry.grain ? '<div class="grain" aria-hidden="true"></div>' : ''}
${progressBar}
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="#top">${logo(plan.theme?.logoMediaId, ctx)}<span>${brand}</span></a>
    <nav class="topnav">
      <button id="langToggle" class="lang-toggle" type="button" aria-label="Language"></button>
      <a class="nav-cta" data-cta target="_top" href="${escapeAttr(composeCtx.ctaHref)}">${i18n({ ar: 'ابدأ الآن', en: 'Start now' })}</a>
    </nav>
  </div>
</header>
<main id="top">
${body}
</main>
<footer class="site-footer"><div class="wrap">© ${brand}</div></footer>
<script>${clientJs(ctx.slug, lang, [...effects])}</script>
</body>
</html>`;
}

/** Only the decorative stylesheets this page actually reached for. */
function decorationCss(design: DesignSpec, used: Set<string>): string[] {
  const out: string[] = [];
  const backdrop = BACKDROP_CSS[design.decoration.backdrop];
  if (backdrop) out.push(backdrop);
  if (design.geometry.grain) out.push(GRAIN_CSS);
  for (const mark of design.decoration.accents) {
    const css = ACCENT_CSS[mark];
    if (css) out.push(css);
  }
  const divider = DIVIDER_CSS[design.decoration.dividers];
  if (divider) out.push(divider);
  // Image treatments and scroll effects are requested by whatever used them.
  for (const id of used) {
    if (id.startsWith('img:')) {
      const css = IMAGE_CSS[id.slice(4) as keyof typeof IMAGE_CSS];
      if (css) out.push(css);
    } else if (id.startsWith('fx:')) {
      const css = SCROLL_FX_CSS[id.slice(3)];
      if (css) out.push(css);
    }
  }
  // The page-level treatment always needs its own rules, even if no pattern
  // asked — a plain `img` still has to know it is meant to be square-cornered.
  const pageTreatment = IMAGE_CSS[design.decoration.imageTreatment];
  if (pageTreatment && !out.includes(pageTreatment)) out.push(pageTreatment);
  for (const fx of design.motion.scrollFx) {
    const css = SCROLL_FX_CSS[fx];
    if (css && !out.includes(css)) out.push(css);
  }
  return out;
}

const ARABIC = /[؀-ۿ]/;

/**
 * Which name to show as the wordmark. The academy name and the owner's account
 * name are frequently the same person written in different scripts; prefer the
 * one written in the page's own script, and fall back to the academy name, which
 * is the field the teacher actually curates.
 */
function brandFor(lang: string, academyName: string, ownerName?: string): string {
  const owner = ownerName?.trim();
  if (!owner) return academyName;
  const academyIsArabic = ARABIC.test(academyName);
  const ownerIsArabic = ARABIC.test(owner);
  if (lang === 'ar') return academyIsArabic ? academyName : ownerIsArabic ? owner : academyName;
  return academyIsArabic && !ownerIsArabic ? owner : academyName;
}

function logo(id: string | undefined, ctx: RenderContext): string {
  if (!id) return '';
  const url = safeUrl(ctx.media(id)?.url);
  if (!url) return '';
  return `<img class="logo" src="${escapeAttr(url)}" alt="" width="38" height="38">`;
}

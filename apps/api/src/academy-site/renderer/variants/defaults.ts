import { SiteBlock } from '../../schema/site-document';
import { ListItem, normalizeItems } from '../../text.util';
import { LT } from '../types';
import { escapeAttr, escapeHtml, safeUrl } from '../html.util';
import { CONTACT_ANCHOR, COURSES_ANCHOR, head, headline, i18n, skeleton } from '../shared';
import { RenderMedia, VariantContext } from '../types';
import { registerVariant, VariantSelectionContext } from './registry';

/** DNAs whose personality suits editorial, statement-style layouts. */
const EDITORIAL_DNA = new Set(['editorial_dark', 'creative_serif']);
const isEditorial = (ctx: VariantSelectionContext) => EDITORIAL_DNA.has(ctx.dna);

/**
 * The `*_01` default variants — the current editorial look, one per section.
 * Extracted verbatim from the old renderer switch so Phase 1 output is
 * unchanged, except that fact lists (toolkit / credentials) now pass through
 * `cleanList` to strip Markdown noise and de-duplicate fragments.
 *
 * Phase 3 registers additional premium variants alongside these.
 */
type Of<T extends SiteBlock['type']> = Extract<SiteBlock, { type: T }>;

/** Render one display list item: bilingual span (toggles) or plain string. */
function itemText(it: ListItem): string {
  return typeof it === 'string' ? escapeHtml(it) : i18n(it);
}

/**
 * The status pill above a hero headline.
 *
 * Small, but it is the first thing that says "someone designed this": a bare
 * headline on an empty background reads as an unstyled document no matter how
 * good the typography under it is.
 */
const HERO_BADGE = `<p class="hero-badge"><span class="dot" aria-hidden="true"></span>${i18n({
  ar: 'الحجز مفتوح الآن',
  en: 'Now enrolling',
})}</p>`;

/**
 * Both hero calls to action.
 *
 * The primary one goes wherever the compiler decided (courses if the page has
 * them, off-page otherwise). The secondary is deliberately an in-page scroll to
 * contact: a visitor who is interested but not ready to enrol has, without it,
 * nothing on the first screen to click.
 */
function heroActions(ctx: VariantContext, label: LT): string {
  return `<div class="hero-actions">
          <a class="btn" data-cta target="_top" href="${escapeAttr(ctx.ctaHref)}">${i18n(label)}<span class="btn-arrow" aria-hidden="true">→</span></a>
          <a class="btn btn-ghost" href="#${CONTACT_ANCHOR}">${i18n({ ar: 'تواصل معي', en: 'Get in touch' })}</a>
        </div>`;
}

/** The animated backdrop layers the hero CSS paints and the client parallaxes. */
const HERO_AURA = '<div class="hero-aura" aria-hidden="true"><i></i><i></i><i></i></div>';

registerVariant(
  'hero',
  'hero_01',
  (b, ctx: VariantContext) => {
    const block = b as Of<'hero'>;
    const cover = block.mediaId ? ctx.media(block.mediaId) : undefined;
    const bg = cover && safeUrl(cover.url)
      ? ` style="background-image:url('${escapeAttr(safeUrl(cover.url))}')"`
      : '';
    return `<section class="block hero${bg ? ' hero-img' : ''}"${bg}>${bg ? '' : HERO_AURA}<div class="wrap">
        ${HERO_BADGE}
        <h1>${headline(block.headline)}</h1>
        <p class="sub">${i18n(block.subheadline)}</p>
        ${heroActions(ctx, block.ctaLabel)}
      </div><a class="hero-scroll" href="#${COURSES_ANCHOR}" aria-hidden="true"><span></span></a></section>`;
  },
  // Centered classic — the safe default; wins when there's no cover image and
  // the direction isn't editorial.
  { score: () => 0.7 },
);

// Split hero: copy on one side, the cover photo (or a decorative panel) on the
// other. Best when a cover image exists.
registerVariant(
  'hero',
  'hero_02',
  (b, ctx: VariantContext) => {
    const block = b as Of<'hero'>;
    const cover = block.mediaId ? ctx.media(block.mediaId) : undefined;
    const url = cover && safeUrl(cover.url);
    const media = url
      ? `<img class="hero-shot" src="${escapeAttr(url)}" alt="" loading="eager">`
      : `<div class="hero-panel" aria-hidden="true"></div>`;
    return `<section class="block hero hero-split">${HERO_AURA}<div class="wrap hero-split-grid">
        <div class="hero-copy">
          ${HERO_BADGE}
          <h1>${headline(block.headline)}</h1>
          <p class="sub">${i18n(block.subheadline)}</p>
          ${heroActions(ctx, block.ctaLabel)}
        </div>
        <div class="hero-media" data-tilt>${media}</div>
      </div></section>`;
  },
  { score: (ctx) => (ctx.hasHeroImage ? 0.95 : 0.55) },
);

// Editorial statement hero: oversized, left-aligned type, no image. Suits
// premium/editorial directions.
registerVariant(
  'hero',
  'hero_03',
  (b, ctx: VariantContext) => {
    const block = b as Of<'hero'>;
    return `<section class="block hero hero-editorial">${HERO_AURA}<div class="wrap">
        ${HERO_BADGE}
        <h1>${headline(block.headline)}</h1>
        <p class="sub">${i18n(block.subheadline)}</p>
        ${heroActions(ctx, block.ctaLabel)}
      </div></section>`;
  },
  { score: (ctx) => (isEditorial(ctx) ? 0.85 : 0.6) },
);

registerVariant(
  'about',
  'about_01',
  (b, ctx: VariantContext) => {
    const block = b as Of<'about'>;
    const img = block.mediaId ? ctx.media(block.mediaId) : undefined;
    const imgHtml = img && safeUrl(img.url)
      ? `<img class="about-img" src="${escapeAttr(safeUrl(img.url))}" alt="" loading="lazy">`
      : '';
    return `<section class="block numbered about"><div class="wrap about-grid">
        <div>${head('about', block.heading)}<p>${i18n(block.body)}</p></div>${imgHtml}
      </div></section>`;
  },
  { score: () => 0.6 },
);

// Statement about: a single centered lead paragraph, editorial and airy. No
// image. Best for editorial directions with a substantial bio.
registerVariant(
  'about',
  'about_02',
  (b) => {
    const block = b as Of<'about'>;
    return `<section class="block numbered about about-statement"><div class="wrap">
        ${head('about', block.heading)}<p class="lead">${i18n(block.body)}</p>
      </div></section>`;
  },
  { score: (ctx) => (isEditorial(ctx) && ctx.bioLength > 200 ? 0.75 : 0.35) },
);

registerVariant('toolkit', 'toolkit_01', (b) => {
  const block = b as Of<'toolkit'>;
  const items = normalizeItems(block.items, { min: 2, maxLen: 60, cap: 20 });
  const tags = items.map((it) => `<span class="tag">${itemText(it)}</span>`).join('');
  if (!tags) return '';
  return `<section class="block numbered toolkit"><div class="wrap">
        ${head('toolkit', block.heading)}<div class="tags">${tags}</div>
      </div></section>`;
});

registerVariant(
  'credentials',
  'credentials_01',
  (b) => {
    const block = b as Of<'credentials'>;
    const items = normalizeItems(block.items, { min: 2, maxLen: 240, cap: 12 });
    const li = items.map((it) => `<li><span>${itemText(it)}</span></li>`).join('');
    if (!li) return '';
    return `<section class="block numbered credentials"><div class="wrap">
        ${head('credentials', block.heading)}<ol class="record">${li}</ol>
      </div></section>`;
  },
  // Numbered editorial list — clean for a handful of credentials.
  { score: () => 0.6 },
);

// Card grid: numbered cards, better when there are many credentials.
registerVariant(
  'credentials',
  'credentials_02',
  (b) => {
    const block = b as Of<'credentials'>;
    const items = normalizeItems(block.items, { min: 2, maxLen: 240, cap: 12 });
    const cards = items.map((it) => `<div class="cred-card"><span>${itemText(it)}</span></div>`).join('');
    if (!cards) return '';
    return `<section class="block numbered credentials cred-cards"><div class="wrap">
        ${head('credentials', block.heading)}<div class="cred-grid">${cards}</div>
      </div></section>`;
  },
  { score: (ctx) => (ctx.achievementsCount >= 5 ? 0.75 : 0.4) },
);

registerVariant('stats', 'stats_01', (b) => {
  const block = b as Of<'stats'>;
  return `<section class="block numbered stats"><div class="wrap">
        ${head('stats', block.heading)}
        <div class="stat-grid">${block.items
          .map((s) => `<div class="stat"><span class="v">${escapeHtml(s.value)}</span><span class="l">${i18n(s.label)}</span></div>`)
          .join('')}</div>
      </div></section>`;
});

registerVariant('faq', 'faq_01', (b) => {
  const block = b as Of<'faq'>;
  return `<section class="block numbered faq"><div class="wrap">
        ${head('faq', block.heading)}
        <div class="faq-list">${block.items
          .map((f) => `<details><summary>${i18n(f.q)}</summary><div>${i18n(f.a)}</div></details>`)
          .join('')}</div>
      </div></section>`;
});

registerVariant('cta', 'cta_01', (b, ctx: VariantContext) => {
  const block = b as Of<'cta'>;
  // A closing call to action that scrolled back to the top of the page was a
  // dead end; it goes where the hero goes.
  return `<section class="block cta"><div class="wrap">
        <h2>${i18n(block.headline)}</h2>
        <a class="btn" data-cta target="_top" href="${escapeAttr(ctx.ctaHref)}">${i18n(block.buttonLabel)}</a>
      </div></section>`;
});

registerVariant('courses', 'courses_01', (b) => {
  const block = b as Of<'courses'>;
  return `<section id="${COURSES_ANCHOR}" data-block="courses-${block.id}" class="block numbered courses" data-hydrate="courses" data-limit="${block.limit}"><div class="wrap">
        ${head('courses', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
});

registerVariant('reviews', 'reviews_01', (b) => {
  const block = b as Of<'reviews'>;
  return `<section class="block numbered reviews" data-hydrate="reviews" data-limit="${block.limit}"><div class="wrap">
        ${head('reviews', block.heading)}
        <div class="cards" data-slot>${skeleton(3)}</div>
      </div></section>`;
});

registerVariant('gallery', 'gallery_01', (b, ctx: VariantContext) => {
  const block = b as Of<'gallery'>;
  const imgs = block.mediaIds
    .map((id) => ctx.media(id))
    .filter((m): m is RenderMedia => !!m && !!safeUrl(m.url))
    .map((m) => `<img src="${escapeAttr(safeUrl(m.url))}" alt="" loading="lazy">`)
    .join('');
  if (!imgs) return '';
  return `<section class="block numbered gallery"><div class="wrap">
        ${head('gallery', block.heading)}<div class="gallery-grid">${imgs}</div>
      </div></section>`;
});

/**
 * Glyphs for the platforms teachers actually link to, keyed by the lower-cased
 * platform name. A link that is only a word is a footnote; a link with a mark in
 * front of it reads as somewhere to go, which is the whole point of the section.
 * Anything unrecognised falls back to a generic link glyph rather than nothing,
 * so an unknown platform still lines up with the rest of the row.
 */
const SOCIAL_GLYPH: Record<string, string> = {
  whatsapp: '💬', telegram: '✈️', facebook: 'f', instagram: '◎', youtube: '▶',
  tiktok: '♪', linkedin: 'in', twitter: '𝕏', x: '𝕏', email: '✉', mail: '✉',
  phone: '☎', website: '⌂', site: '⌂',
};

registerVariant('contact', 'contact_01', (b) => {
  const block = b as Of<'contact'>;
  const links = block.socials
    .filter((s) => safeUrl(s.url))
    .map((s) => {
      const glyph = SOCIAL_GLYPH[s.platform.trim().toLowerCase()] ?? '↗';
      return `<a class="social" href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer nofollow"><span class="social-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>${escapeHtml(s.platform)}</a>`;
    })
    .join('');
  return `<section id="${CONTACT_ANCHOR}" class="block contact"><div class="wrap">
        <h2>${i18n(block.heading)}</h2><div class="socials">${links}</div>
      </div></section>`;
});

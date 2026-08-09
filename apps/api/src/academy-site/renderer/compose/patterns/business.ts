import { SiteBlock } from '../../../schema/site-document';
import { escapeAttr, escapeHtml, safeUrl } from '../../html.util';
import { RenderMedia } from '../../types';
import {
  CONTACT_ANCHOR, COURSES_ANCHOR, SECTION_CLOSE, SOCIAL_GLYPH, actions, i18n, image,
  sectionHead, sectionOpen, skeleton,
} from '../helpers';
import { registerPattern } from '../registry';

/**
 * Business sections: courses, reviews, gallery, contact and the closing call to
 * action.
 *
 * The composition decides where these sit and what they look like. It decides
 * nothing about what they do. The endpoint, the query, the price, the link a
 * course card points at and the destination of every button are resolved by the
 * platform — a pattern here receives a limit and a layout, and that is the whole
 * surface. There is no field in which a composition could supply a URL.
 */

type Of<T extends SiteBlock['type']> = Extract<SiteBlock, { type: T }>;

const CARD_CSS = `
.course-card{display:flex;flex-direction:column;padding:0;overflow:hidden;text-decoration:none;color:inherit}
.course-card .img{border-radius:0}
.course-card .course-body{padding:1.2em 1.3em 1.4em;display:flex;flex-direction:column;gap:.5em}
.course-card h3{font-size:1.05rem}
.course-card .price{font-family:var(--font-h);font-weight:700;color:var(--a-text)}
.course-card:hover .img{transform:scale(1.04)}
.course-card .img{transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.review-card{margin:0;display:flex;flex-direction:column;gap:.8em}
.review-card .rating{color:var(--a-text);letter-spacing:.15em}
.review-card blockquote{margin:0;color:var(--body)}
.review-card figcaption{font-family:var(--font-h);font-weight:700;color:var(--ink);font-size:.95rem}`;

// ── Courses ──────────────────────────────────────────────────────────────────

registerPattern({
  id: 'courses.grid',
  section: 'courses',
  brief: 'A responsive grid of course cards. The dependable default.',
  base: 1,
  js: ['pointer-glow'],
  css: () => `${CARD_CSS}
.courses-grid [data-slot]{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fill,minmax(min(100%,270px),1fr))}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'courses'>;
    ctx.useDecor('fx:pointer-glow');
    ctx.useEffect('pointer-glow');
    return `${sectionOpen('courses', spec, ctx, { id: COURSES_ANCHOR, extraClass: 'courses courses-grid', hydrate: 'courses', limit: block.limit })}
      ${sectionHead('courses', block.heading)}<div data-slot>${skeleton(3)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'courses.bento',
  section: 'courses',
  brief: 'An uneven grid where the first course takes a double cell. Needs several courses to look deliberate.',
  needs: { courses: 4 },
  base: 1.1,
  weight: { programming: 1.4, exam_prep: 1.1 },
  js: ['pointer-glow'],
  css: () => `${CARD_CSS}
.courses-bento [data-slot]{display:grid;gap:var(--gap);grid-template-columns:1fr}
@media(min-width:760px){
  .courses-bento [data-slot]{grid-template-columns:repeat(4,1fr);grid-auto-flow:dense}
  .courses-bento [data-slot]>*{grid-column:span 2}
  .courses-bento [data-slot]>*:first-child{grid-column:span 4}
  .courses-bento [data-slot]>*:first-child .img{aspect-ratio:21/9}
}
@media(min-width:1100px){
  .courses-bento [data-slot]>*:first-child{grid-column:span 2;grid-row:span 2}
  .courses-bento [data-slot]>*:first-child .img{aspect-ratio:4/3}
  .courses-bento [data-slot]>*{grid-column:span 1}
}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'courses'>;
    ctx.useDecor('fx:pointer-glow');
    ctx.useEffect('pointer-glow');
    return `${sectionOpen('courses', spec, ctx, { id: COURSES_ANCHOR, extraClass: 'courses courses-bento', hydrate: 'courses', limit: block.limit })}
      ${sectionHead('courses', block.heading)}<div data-slot>${skeleton(4)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'courses.rail',
  section: 'courses',
  brief: 'A horizontally scrolling rail. Keeps a long catalogue from dominating the page.',
  needs: { courses: 3 },
  base: 1,
  weight: { languages: 1.3 },
  css: () => `${CARD_CSS}
.courses-rail [data-slot]{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(260px,32%);gap:var(--gap);overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:1em;scrollbar-width:thin}
.courses-rail [data-slot]>*{scroll-snap-align:start}
@media(max-width:640px){.courses-rail [data-slot]{grid-auto-columns:minmax(230px,78%)}}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'courses'>;
    return `${sectionOpen('courses', spec, ctx, { id: COURSES_ANCHOR, extraClass: 'courses courses-rail', hydrate: 'courses', limit: block.limit })}
      ${sectionHead('courses', block.heading)}<div data-slot>${skeleton(3)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'courses.list',
  section: 'courses',
  brief: 'A quiet vertical list with no images. For a small catalogue, or a page whose weight is elsewhere.',
  base: .9,
  weight: { university: 1.3, math_science: 1.1 },
  css: () => `${CARD_CSS}
.courses-list [data-slot]{display:flex;flex-direction:column}
.courses-list .course-card{flex-direction:row;align-items:center;gap:1.2em;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:1.2em 0}
.courses-list .course-card .img{width:110px;flex:0 0 110px;aspect-ratio:4/3;border-radius:var(--rad-s)}
.courses-list .course-card .course-body{padding:0;flex:1;flex-direction:row;justify-content:space-between;align-items:center;gap:1em}
.courses-list .skeleton{min-height:90px;margin-top:1px}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'courses'>;
    return `${sectionOpen('courses', spec, ctx, { id: COURSES_ANCHOR, extraClass: 'courses courses-list', hydrate: 'courses', limit: block.limit })}
      ${sectionHead('courses', block.heading)}<div data-slot>${skeleton(3)}</div>${SECTION_CLOSE}`;
  },
});

// ── Reviews ──────────────────────────────────────────────────────────────────

registerPattern({
  id: 'reviews.cards',
  section: 'reviews',
  brief: 'Review cards in a grid. Straightforward social proof.',
  base: 1,
  css: () => `${CARD_CSS}
.reviews-cards [data-slot]{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'reviews'>;
    return `${sectionOpen('reviews', spec, ctx, { extraClass: 'reviews reviews-cards', hydrate: 'reviews', limit: block.limit })}
      ${sectionHead('reviews', block.heading)}<div data-slot>${skeleton(3)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'reviews.wall',
  section: 'reviews',
  brief: 'A masonry wall of quotations. Reads as volume of goodwill. Needs several reviews.',
  needs: { reviews: 4 },
  base: 1.1,
  weight: { languages: 1.4, exam_prep: 1.25 },
  css: () => `${CARD_CSS}
.reviews-wall [data-slot]{columns:1;column-gap:var(--gap)}
@media(min-width:700px){.reviews-wall [data-slot]{columns:2}}
@media(min-width:1080px){.reviews-wall [data-slot]{columns:3}}
.reviews-wall .review-card{break-inside:avoid;margin-bottom:var(--gap);display:block}
.reviews-wall .review-card blockquote{margin:.6em 0}
.reviews-wall .skeleton{margin-bottom:var(--gap)}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'reviews'>;
    return `${sectionOpen('reviews', spec, ctx, { extraClass: 'reviews reviews-wall', hydrate: 'reviews', limit: block.limit })}
      ${sectionHead('reviews', block.heading)}<div data-slot>${skeleton(4)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'reviews.spotlight',
  section: 'reviews',
  brief: 'One review at a time, set large. Dignified when there are only a few.',
  base: .95,
  weight: { university: 1.2 },
  css: () => `${CARD_CSS}
.reviews-spot [data-slot]{display:grid;gap:var(--gap);grid-template-columns:1fr}
.reviews-spot .review-card{border:0;background:transparent;padding:0;text-align:center;align-items:center}
.reviews-spot .review-card blockquote{font-family:var(--font-h);font-size:var(--h3);line-height:1.45;color:var(--ink);max-width:44ch;margin-inline:auto}
.reviews-spot .review-card:not(:first-child){display:none}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'reviews'>;
    return `${sectionOpen('reviews', spec, ctx, { extraClass: 'reviews reviews-spot', hydrate: 'reviews', limit: block.limit })}
      ${sectionHead('reviews', block.heading)}<div data-slot>${skeleton(1)}</div>${SECTION_CLOSE}`;
  },
});

// ── Gallery ──────────────────────────────────────────────────────────────────

function galleryImages(block: Of<'gallery'>, ctx: Parameters<typeof image>[1]): string[] {
  return block.mediaIds
    .map((id) => ctx.media(id))
    .filter((m): m is RenderMedia => !!m && !!safeUrl(m.url))
    .map((m) => `<img class="img" src="${escapeAttr(safeUrl(m.url))}" alt="" loading="lazy">`);
}

registerPattern({
  id: 'gallery.mosaic',
  section: 'gallery',
  brief: 'A mosaic with one frame taking a double cell, so the grid has a focal point.',
  base: 1,
  css: () => `.gal-mosaic .g{display:grid;gap:var(--gap);grid-template-columns:repeat(2,1fr);grid-auto-flow:dense}
@media(min-width:800px){.gal-mosaic .g{grid-template-columns:repeat(4,1fr)}
.gal-mosaic .g img:first-child{grid-column:span 2;grid-row:span 2}}
.gal-mosaic img{aspect-ratio:1;height:100%;border-radius:var(--rad);transition:transform .5s cubic-bezier(.2,.7,.2,1)}
.gal-mosaic .g img:first-child{aspect-ratio:auto}
.gal-mosaic img:hover{transform:scale(1.03)}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'gallery'>;
    const imgs = galleryImages(block, ctx);
    if (!imgs.length) return '';
    return `${sectionOpen('gallery', spec, ctx, { extraClass: 'gallery gal-mosaic' })}
      ${sectionHead('gallery', block.heading)}<div class="g">${imgs.join('')}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'gallery.immersive',
  section: 'gallery',
  brief: 'Full-bleed edge-to-edge frames with no container. Needs six or more images to earn the space.',
  needs: { gallery: 6 },
  base: 1.15,
  fullBleed: true,
  css: () => `.gal-immersive .g{display:grid;gap:2px;grid-template-columns:repeat(2,1fr)}
@media(min-width:900px){.gal-immersive .g{grid-template-columns:repeat(3,1fr)}}
.gal-immersive img{aspect-ratio:4/5;border-radius:0;transition:filter .4s,transform .6s}
.gal-immersive img:hover{filter:brightness(1.06);transform:scale(1.02)}
.gal-immersive .gal-head{padding-inline:var(--gut);max-width:var(--wrap);margin-inline:auto}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'gallery'>;
    const imgs = galleryImages(block, ctx);
    if (!imgs.length) return '';
    return `${sectionOpen('gallery', spec, ctx, { extraClass: 'gallery gal-immersive' })}
      <div class="gal-head">${sectionHead('gallery', block.heading)}</div>
      <div class="g">${imgs.join('')}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'gallery.filmstrip',
  section: 'gallery',
  brief: 'A single scrolling strip. Quiet, and safe with an awkward number of images.',
  base: .95,
  css: () => `.gal-strip .g{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,26%);gap:var(--gap);overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:1em}
.gal-strip img{aspect-ratio:3/4;border-radius:var(--rad);scroll-snap-align:start}
@media(max-width:640px){.gal-strip .g{grid-auto-columns:minmax(170px,62%)}}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'gallery'>;
    const imgs = galleryImages(block, ctx);
    if (!imgs.length) return '';
    return `${sectionOpen('gallery', spec, ctx, { extraClass: 'gallery gal-strip' })}
      ${sectionHead('gallery', block.heading)}<div class="g">${imgs.join('')}</div>${SECTION_CLOSE}`;
  },
});

// ── Contact ──────────────────────────────────────────────────────────────────

function socialLinks(block: Of<'contact'>): string {
  return block.socials
    .filter((s) => safeUrl(s.url))
    .map((s) => {
      const glyph = SOCIAL_GLYPH[s.platform.trim().toLowerCase()] ?? '↗';
      return `<a class="social" href="${escapeAttr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer nofollow"><span class="social-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>${escapeHtml(s.platform)}</a>`;
    })
    .join('');
}

const SOCIAL_CSS = `
.socials{display:flex;flex-wrap:wrap;gap:12px}
.center .socials{justify-content:center}
.social{display:inline-flex;align-items:center;gap:.6em;border:1px solid color-mix(in srgb,var(--a) 40%,transparent);color:var(--a-text);border-radius:var(--pill);padding:.75em 1.4em;text-decoration:none;font-family:var(--font-h);font-weight:700;text-transform:capitalize;transition:.24s}
.social:hover{background:var(--a);color:var(--on-a);border-color:var(--a);transform:translateY(-3px)}
.social-glyph{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--a) 15%,transparent);font-size:.85rem;line-height:1}`;

registerPattern({
  id: 'contact.pills',
  section: 'contact',
  brief: 'Social links as a row of pills under a heading. Light and unobtrusive.',
  base: 1,
  css: () => SOCIAL_CSS,
  render: (b, spec, ctx) => {
    const block = b as Of<'contact'>;
    return `${sectionOpen('contact', spec, ctx, { id: CONTACT_ANCHOR, extraClass: 'contact' })}
      ${sectionHead('contact', block.heading, { eyebrow: false })}
      <div class="socials">${socialLinks(block)}</div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'contact.split-cta',
  section: 'contact',
  brief: 'A closing invitation on one side and the ways to reach the teacher on the other.',
  base: 1.05,
  weight: { exam_prep: 1.3, programming: 1.15 },
  css: () => `${SOCIAL_CSS}
.contact-split .split{--split:1.05fr .95fr;align-items:center}
.contact-split .socials{justify-content:flex-start}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'contact'>;
    return `${sectionOpen('contact', spec, ctx, { id: CONTACT_ANCHOR, extraClass: 'contact contact-split' })}
      <div class="split">
        <div>${sectionHead('contact', block.heading, { eyebrow: false })}
          ${actions(ctx, { ar: 'ابدأ الآن', en: 'Start now' }, { secondary: false })}</div>
        <div class="socials">${socialLinks(block)}</div>
      </div>${SECTION_CLOSE}`;
  },
});

registerPattern({
  id: 'contact.band',
  section: 'contact',
  brief: 'A centred closing band. Works well as the page\'s final full-width statement.',
  base: 1,
  css: () => SOCIAL_CSS,
  render: (b, spec, ctx) => {
    const block = b as Of<'contact'>;
    return `${sectionOpen('contact', spec, ctx, { id: CONTACT_ANCHOR, extraClass: 'contact center' })}
      ${sectionHead('contact', block.heading, { eyebrow: false })}
      <div class="socials">${socialLinks(block)}</div>${SECTION_CLOSE}`;
  },
});

// ── Closing call to action ───────────────────────────────────────────────────

registerPattern({
  id: 'cta.band',
  section: 'cta',
  brief: 'A closing call to action. Use sparingly — the hero and the sticky nav already ask.',
  base: 1,
  css: () => `.cta-band .wrap{text-align:center}
.cta-band h2{margin-inline:auto;max-width:20ch}
.cta-band .actions{justify-content:center}`,
  render: (b, spec, ctx) => {
    const block = b as Of<'cta'>;
    return `${sectionOpen('cta', spec, ctx, { extraClass: 'cta-band' })}
      <h2>${i18n(block.headline)}</h2>${actions(ctx, block.buttonLabel, { secondary: false })}${SECTION_CLOSE}`;
  },
});
